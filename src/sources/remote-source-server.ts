import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, rm } from "node:fs/promises";
import { createServer as createHttpServer, type IncomingMessage, type Server as HttpServer } from "node:http";
import { createServer as createHttpsServer, type Server as HttpsServer } from "node:https";
import { networkInterfaces } from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { WebSocketServer, type RawData, type WebSocket } from "ws";

import type { AudioSourceId } from "../audio/types.js";
import type { AppLogger } from "../logging/app-logger.js";
import type { NativeAudioManager } from "./native-audio-manager.js";

export interface RemoteSourceEndpoint {
  readonly sourceId: AudioSourceId;
  readonly token: string;
  readonly urls: readonly string[];
  readonly secure: boolean;
  readonly notice: string;
}

interface PrivateTlsMaterial {
  readonly hostname: string;
  readonly cert: Buffer;
  readonly key: Buffer;
}

const execFileAsync = promisify(execFile);

export class RemoteSourceServer {
  private readonly sources = new Map<string, AudioSourceId>();
  private readonly sockets = new Map<AudioSourceId, Set<WebSocket>>();
  private server: HttpServer | HttpsServer | undefined;
  private webSockets: WebSocketServer | undefined;
  private privateHostname: string | undefined;
  private notice = "浏览器会阻止 HTTP 局域网页面使用麦克风；请先在 Tailscale 管理页启用 HTTPS 证书。";

  constructor(
    private readonly audio: NativeAudioManager,
    private readonly logger: AppLogger,
    readonly port = 47321,
    private readonly rootDirectory = process.cwd(),
  ) {}

  async start(): Promise<void> {
    if (this.server) return;
    const webSockets = new WebSocketServer({ noServer: true, maxPayload: 1024 * 1024 });
    const tls = await this.loadTailscaleTls();
    this.privateHostname = tls?.hostname;
    this.notice = tls
      ? "访问仅限同一 Tailscale 私有网络；证书域名会记录在公开 CT 日志。"
      : "浏览器会阻止 HTTP 局域网页面使用麦克风；请先在 Tailscale 管理页启用 HTTPS 证书。";
    const server = tls
      ? createHttpsServer({ cert: tls.cert, key: tls.key }, (request, response) => this.handleHttp(request, response))
      : createHttpServer((request, response) => this.handleHttp(request, response));
    server.on("upgrade", (request, socket, head) => {
      const match = new URL(request.url ?? "/", `http://${request.headers.host ?? "localhost"}`)
        .pathname.match(/^\/source\/([^/]+)\/stream$/u);
      const sourceId = match?.[1] ? this.sources.get(match[1]) : undefined;
      if (!sourceId) {
        socket.destroy();
        return;
      }
      webSockets.handleUpgrade(request, socket, head, (webSocket) => {
        this.attachSocket(sourceId, webSocket);
      });
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(this.port, "0.0.0.0", () => {
        server.off("error", reject);
        resolve();
      });
    });
    this.server = server;
    this.webSockets = webSockets;
    this.logger.info(
      `Remote source page listening on port ${this.port} (${tls ? "Tailscale HTTPS" : "HTTP fallback"})`,
      "remote",
    );
  }

  register(sourceId: AudioSourceId, token: string): RemoteSourceEndpoint {
    this.sources.set(token, sourceId);
    return this.endpoint(sourceId, token);
  }

  endpoint(sourceId: AudioSourceId, token: string): RemoteSourceEndpoint {
    return {
      sourceId,
      token,
      urls: this.urlsFor(token),
      secure: Boolean(this.privateHostname),
      notice: this.notice,
    };
  }

  async stop(): Promise<void> {
    for (const sockets of this.sockets.values()) {
      for (const socket of sockets) socket.close();
    }
    this.sockets.clear();
    this.webSockets?.close();
    this.webSockets = undefined;
    const server = this.server;
    this.server = undefined;
    if (server) {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  }

  private handleHttp(request: IncomingMessage, response: import("node:http").ServerResponse): void {
    const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "localhost"}`);
    const match = url.pathname.match(/^\/source\/([^/]+)$/u);
    const sourceId = match?.[1] ? this.sources.get(match[1]) : undefined;
    if (!sourceId || !match?.[1]) {
      response.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
      response.end("Remote source not found");
      return;
    }
    const html = renderRemotePage(match[1]);
    response.writeHead(200, {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
      "Content-Security-Policy": "default-src 'self'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src ws: wss:; media-src 'self';",
    });
    response.end(html);
  }

  private attachSocket(sourceId: AudioSourceId, socket: WebSocket): void {
    const sockets = this.sockets.get(sourceId) ?? new Set<WebSocket>();
    sockets.add(socket);
    this.sockets.set(sourceId, sockets);
    socket.on("message", (data, isBinary) => {
      if (!isBinary) return;
      const buffer = rawDataToBuffer(data);
      if (buffer.byteLength === 0 || buffer.byteLength % Float32Array.BYTES_PER_ELEMENT !== 0) return;
      const copy = buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength);
      this.audio.pushRemoteFrame(sourceId, new Float32Array(copy));
    });
    socket.on("close", () => {
      sockets.delete(socket);
      if (sockets.size === 0) {
        this.sockets.delete(sourceId);
        this.audio.disconnectRemote(sourceId);
      }
    });
    socket.on("error", (error) => this.logger.warn(error.message, `remote:${sourceId}`));
  }

  private urlsFor(token: string): string[] {
    if (this.privateHostname) {
      return [`https://${this.privateHostname}:${this.port}/source/${token}`];
    }
    const hosts = new Set<string>(["127.0.0.1"]);
    for (const addresses of Object.values(networkInterfaces())) {
      for (const address of addresses ?? []) {
        if (address.family === "IPv4" && !address.internal) hosts.add(address.address);
      }
    }
    return [...hosts].map((host) => `http://${host}:${this.port}/source/${token}`);
  }

  private async loadTailscaleTls(): Promise<PrivateTlsMaterial | undefined> {
    if (process.platform !== "win32" || process.env.CI === "true") return undefined;
    const executable = resolveTailscaleExecutable();
    if (!executable) return undefined;
    try {
      const statusResult = await execFileAsync(executable, ["status", "--json"], {
        encoding: "utf8",
        timeout: 4000,
        windowsHide: true,
      });
      const status = JSON.parse(String(statusResult.stdout)) as unknown;
      const hostname = tailscaleCertificateHostname(status);
      if (!hostname) return undefined;

      const certificateDirectory = path.join(this.rootDirectory, "data", ".remote-tls");
      await mkdir(certificateDirectory, { recursive: true });
      const nonce = randomUUID();
      const certificatePath = path.join(certificateDirectory, `${nonce}.crt`);
      const keyPath = path.join(certificateDirectory, `${nonce}.key`);
      try {
        await execFileAsync(executable, [
          "cert",
          "--min-validity=24h",
          `--cert-file=${certificatePath}`,
          `--key-file=${keyPath}`,
          hostname,
        ], {
          encoding: "utf8",
          timeout: 12000,
          windowsHide: true,
        });
        const [cert, key] = await Promise.all([readFile(certificatePath), readFile(keyPath)]);
        return { hostname, cert, key };
      } finally {
        await Promise.allSettled([
          rm(certificatePath, { force: true }),
          rm(keyPath, { force: true }),
        ]);
      }
    } catch (error) {
      this.logger.warn(`Private HTTPS is unavailable: ${errorMessage(error)}`, "remote");
      return undefined;
    }
  }
}

function resolveTailscaleExecutable(): string | undefined {
  const programFiles = process.env.ProgramFiles ?? "C:\\Program Files";
  const installed = path.join(programFiles, "Tailscale", "tailscale.exe");
  return existsSync(installed) ? installed : undefined;
}

function tailscaleCertificateHostname(value: unknown): string | undefined {
  if (!isRecord(value) || !isRecord(value.Self) || typeof value.Self.DNSName !== "string") {
    return undefined;
  }
  const certificateDomains = Array.isArray(value.CertDomains)
    ? value.CertDomains.filter((item): item is string => typeof item === "string")
    : [];
  if (certificateDomains.length === 0) return undefined;
  const dnsName = value.Self.DNSName.replace(/\.$/u, "");
  return certificateDomains.find((domain) => domain.replace(/\.$/u, "") === dnsName)
    ?.replace(/\.$/u, "");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function rawDataToBuffer(data: RawData): Buffer {
  if (Buffer.isBuffer(data)) return data;
  if (Array.isArray(data)) return Buffer.concat(data);
  return Buffer.from(data);
}

function renderRemotePage(token: string): string {
  const safeToken = JSON.stringify(token);
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>LiveTranslating 远程声源</title>
  <style>
    :root{font-family:"Segoe UI","Microsoft YaHei UI",sans-serif;color:#202426;background:#f4f6f6}*{box-sizing:border-box}body{margin:0;min-height:100vh;display:grid;place-items:center;padding:24px}main{width:min(480px,100%);background:#fff;border:1px solid #cbd1d2;border-radius:8px;padding:24px}h1{margin:0 0 22px;font-size:22px}label{display:flex;flex-direction:column;gap:7px;font-size:13px;color:#60686b}select,button{height:42px;border:1px solid #cbd1d2;border-radius:6px;background:#fff;color:#202426;font:600 14px inherit}select{padding:0 12px}div{display:flex;gap:10px;margin-top:18px}button{flex:1;cursor:pointer}button.primary{border-color:#087f78;background:#087f78;color:#fff}button:disabled{opacity:.45;cursor:not-allowed}p{min-height:22px;margin:18px 0 0;color:#60686b;font-size:13px;line-height:1.5}.error{color:#b93734}
  </style>
</head>
<body><main>
  <h1>选择采集声音</h1>
  <label>输入设备<select id="device"><option value="">默认麦克风</option></select></label>
  <div><button id="start" class="primary">开始</button><button id="stop" disabled>结束</button></div>
  <p id="status">尚未开始</p>
</main>
<script>
const token=${safeToken};const select=document.querySelector('#device');const start=document.querySelector('#start');const stop=document.querySelector('#stop');const status=document.querySelector('#status');let stream,context,processor,socket,queue=[];
function setStatus(text,error=false){status.textContent=text;status.className=error?'error':''}
async function loadDevices(){if(!navigator.mediaDevices?.enumerateDevices)return;const devices=await navigator.mediaDevices.enumerateDevices();for(const item of devices.filter(x=>x.kind==='audioinput')){const option=document.createElement('option');option.value=item.deviceId;option.textContent=item.label||'麦克风 '+(select.options.length);select.append(option)}}
function downsample(input,sourceRate){if(sourceRate===16000)return input;const length=Math.max(1,Math.round(input.length*16000/sourceRate));const output=new Float32Array(length);for(let i=0;i<length;i++){const pos=i*sourceRate/16000;const left=Math.floor(pos);const right=Math.min(input.length-1,left+1);const ratio=pos-left;output[i]=(input[left]||0)*(1-ratio)+(input[right]||0)*ratio}return output}
function sendFrames(input){queue.push(...input);while(queue.length>=1600&&socket?.readyState===1){const frame=new Float32Array(queue.splice(0,1600));socket.send(frame.buffer)}}
start.onclick=async()=>{try{if(!navigator.mediaDevices?.getUserMedia)throw new Error('当前浏览器不允许此 HTTP 页面访问麦克风，请使用受信任的 HTTPS 页面或在同一电脑上打开');stream=await navigator.mediaDevices.getUserMedia({audio:select.value?{deviceId:{exact:select.value}}:true});context=new AudioContext();const source=context.createMediaStreamSource(stream);processor=context.createScriptProcessor(4096,1,1);source.connect(processor);processor.connect(context.destination);const protocol=location.protocol==='https:'?'wss:':'ws:';socket=new WebSocket(protocol+'//'+location.host+'/source/'+token+'/stream');socket.binaryType='arraybuffer';processor.onaudioprocess=event=>sendFrames(downsample(event.inputBuffer.getChannelData(0),context.sampleRate));start.disabled=true;stop.disabled=false;setStatus('正在采集')}catch(error){setStatus(error.message||String(error),true)}};
stop.onclick=async()=>{processor?.disconnect();stream?.getTracks().forEach(track=>track.stop());socket?.close();await context?.close();queue=[];start.disabled=false;stop.disabled=true;setStatus('已结束')};
loadDevices().catch(()=>{});
</script></body></html>`;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
