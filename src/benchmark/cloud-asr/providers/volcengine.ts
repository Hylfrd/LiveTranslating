import { randomUUID } from "node:crypto";
import { gunzipSync, gzipSync } from "node:zlib";

import type WebSocket from "ws";

import type {
  CloudAsrAdapter,
  CloudAsrConnectOptions,
  CloudAsrEvent,
  CloudAsrSession,
} from "../types.js";
import {
  closeWebSocket,
  createWebSocket,
  deferred,
  isRecord,
  sendWebSocket,
  waitForOpen,
  withTimeout,
} from "../websocket.js";

const DEFAULT_ENDPOINT = "wss://openspeech.bytedance.com/api/v3/sauc/bigmodel_async";
const DEFAULT_RESOURCE_ID = "volc.seedasr.sauc.duration";

export class VolcengineAsrAdapter implements CloudAsrAdapter {
  readonly id = "volcengine" as const;
  readonly requiredEnvironment = ["VOLCENGINE_ASR_API_KEY"] as const;
  readonly recommendedFrameMs = [200] as const;

  async connect(
    options: CloudAsrConnectOptions,
    emit: (event: CloudAsrEvent) => void,
  ): Promise<CloudAsrSession> {
    const apiKey = requireEnvironment("VOLCENGINE_ASR_API_KEY");
    const endpoint = stringOption(options, "endpoint")
      ?? process.env.VOLCENGINE_ASR_WS_URL?.trim()
      ?? DEFAULT_ENDPOINT;
    const resourceId = stringOption(options, "resourceId")
      ?? process.env.VOLCENGINE_ASR_RESOURCE_ID?.trim()
      ?? DEFAULT_RESOURCE_ID;
    const connectId = randomUUID();
    const finished = deferred<void>();
    const emittedFinals = new Set<string>();
    let revision = 0;
    let providerFailure: Error | undefined;
    let logId: string | undefined;
    let completed = false;
    const socket = createWebSocket(endpoint, {
      "X-Api-Key": apiKey,
      "X-Api-Resource-Id": resourceId,
      "X-Api-Connect-Id": connectId,
    }, options.signal);
    socket.once("upgrade", (response) => {
      const value = response.headers["x-tt-logid"];
      logId = Array.isArray(value) ? value[0] : value;
    });

    socket.on("message", (data) => {
      try {
        const parsed = parseServerFrame(data);
        emit({ type: "raw", provider: this.id, receivedAtMs: Date.now(), raw: { ...parsed, logId } });
        if (parsed.error) {
          providerFailure = new Error(`Volcengine ASR ${parsed.error.code}: ${parsed.error.message}`);
          finished.reject(providerFailure);
          emitError(emit, providerFailure, { ...parsed, logId });
          return;
        }
        if (!parsed.payload || !isRecord(parsed.payload)) {
          if (parsed.streamFinal) finished.resolve();
          return;
        }
        const result = isRecord(parsed.payload.result) ? parsed.payload.result : undefined;
        const fullText = result && typeof result.text === "string" ? result.text : "";
        revision += 1;
        if (fullText) {
          emit({
            type: "partial",
            provider: this.id,
            receivedAtMs: Date.now(),
            utteranceId: "stream",
            revision,
            unstableText: fullText,
            text: fullText,
            raw: { ...parsed.payload, logId },
          });
        }
        const utterances = result && Array.isArray(result.utterances) ? result.utterances : [];
        for (const value of utterances) {
          if (!isRecord(value) || value.definite !== true || typeof value.text !== "string") continue;
          const start = numericValue(value.start_time);
          const end = numericValue(value.end_time);
          const key = `${start ?? ""}:${end ?? ""}:${value.text}`;
          if (emittedFinals.has(key)) continue;
          emittedFinals.add(key);
          emit({
            type: "final",
            provider: this.id,
            receivedAtMs: Date.now(),
            utteranceId: key,
            revision,
            stableText: value.text,
            text: value.text,
            ...numberField(start, "audioStartMs"),
            ...numberField(end, "audioEndMs"),
            ...utteranceLanguage(value),
            raw: { ...parsed.payload, logId },
          });
        }
        if (parsed.streamFinal) {
          completed = true;
          finished.resolve();
          emit({
            type: "session-finished",
            provider: this.id,
            receivedAtMs: Date.now(),
            raw: { ...parsed.payload, logId },
          });
        }
      } catch (error) {
        providerFailure = new Error(`Volcengine frame parse failed: ${errorMessage(error)}`);
        finished.reject(providerFailure);
        emitError(emit, providerFailure, { logId });
      }
    });
    socket.on("error", (error) => {
      providerFailure = error;
      finished.reject(error);
      emitError(emit, error, { socket: "error", logId });
    });
    socket.on("close", (code, reason) => {
      if (completed || providerFailure) return;
      providerFailure = closedError("Volcengine", code, reason);
      finished.reject(providerFailure);
      emitError(emit, providerFailure, { socket: "close", code, reason: reason.toString("utf8"), logId });
    });

    try {
      await waitForOpen(socket, options.signal);
      await sendWebSocket(socket, encodeFullClientRequest(options));
    } catch (error) {
      await closeWebSocket(socket);
      throw error;
    }
    emit({
      type: "session-ready",
      provider: this.id,
      receivedAtMs: Date.now(),
      raw: { connectId, resourceId, ...(logId ? { logId } : {}) },
    });
    return createSession(socket, {
      send: (frame, final) => sendWebSocket(socket, encodeAudioFrame(frame, final)),
      finish: async () => {
        if (providerFailure) throw providerFailure;
        await withTimeout(finished.promise, 30_000, "Volcengine session finish");
      },
    });
  }
}

function encodeFullClientRequest(options: CloudAsrConnectOptions): Buffer {
  const request = {
    user: { uid: randomUUID(), platform: "Windows", sdk_version: "live-translating-benchmark" },
    audio: { format: "pcm", codec: "raw", rate: options.sampleRate, bits: 16, channel: 1 },
    request: {
      model_name: "bigmodel",
      enable_itn: true,
      enable_punc: true,
      enable_ddc: false,
      show_utterances: true,
      result_type: "full",
      enable_nonstream: true,
      end_window_size: numberOption(options, "endWindowMs") ?? 800,
      ...(booleanOption(options, "enableLid") ? { enable_lid: true } : {}),
      ...(numberOption(options, "forceToSpeechMs") === undefined
        ? {}
        : { force_to_speech_time: numberOption(options, "forceToSpeechMs") }),
    },
  };
  return encodeFrame(0x10, 0x11, gzipSync(Buffer.from(JSON.stringify(request), "utf8")));
}

function encodeAudioFrame(frame: Buffer, final: boolean): Buffer {
  return encodeFrame(final ? 0x22 : 0x20, 0x01, gzipSync(frame));
}

function encodeFrame(messageTypeAndFlags: number, serializationAndCompression: number, payload: Buffer): Buffer {
  const header = Buffer.alloc(8);
  header[0] = 0x11;
  header[1] = messageTypeAndFlags;
  header[2] = serializationAndCompression;
  header[3] = 0;
  header.writeUInt32BE(payload.length, 4);
  return Buffer.concat([header, payload]);
}

interface ParsedServerFrame {
  readonly payload?: unknown;
  readonly streamFinal: boolean;
  readonly sequence?: number;
  readonly error?: { readonly code: number; readonly message: string };
}

function parseServerFrame(data: WebSocket.RawData): ParsedServerFrame {
  const buffer = Buffer.isBuffer(data)
    ? data
    : Array.isArray(data) ? Buffer.concat(data) : Buffer.from(data as ArrayBuffer);
  if (buffer.length < 4) throw new Error("response header is shorter than 4 bytes");
  const headerBytes = (buffer[0]! & 0x0f) * 4;
  const messageType = buffer[1]! >> 4;
  const flags = buffer[1]! & 0x0f;
  const serialization = buffer[2]! >> 4;
  const compression = buffer[2]! & 0x0f;
  let offset = headerBytes;
  if (messageType === 0x0f) {
    if (buffer.length < offset + 8) throw new Error("error response is truncated");
    const code = buffer.readUInt32BE(offset);
    const length = buffer.readUInt32BE(offset + 4);
    const encodedMessage = buffer.subarray(offset + 8, offset + 8 + length);
    const messageBuffer = compression === 1 ? gunzipSync(encodedMessage) : encodedMessage;
    const message = messageBuffer.toString("utf8");
    return { streamFinal: true, error: { code, message } };
  }
  if (messageType !== 0x09) return { streamFinal: flags === 3 };
  let sequence: number | undefined;
  if (flags === 1 || flags === 3) {
    if (buffer.length < offset + 4) throw new Error("response sequence is truncated");
    sequence = buffer.readInt32BE(offset);
    offset += 4;
  }
  if (buffer.length < offset + 4) throw new Error("response payload length is missing");
  const length = buffer.readUInt32BE(offset);
  offset += 4;
  const encodedPayload = buffer.subarray(offset, offset + length);
  const payloadBuffer = compression === 1 ? gunzipSync(encodedPayload) : encodedPayload;
  const payload: unknown = serialization === 1
    ? JSON.parse(payloadBuffer.toString("utf8"))
    : payloadBuffer.toString("utf8");
  return {
    payload,
    streamFinal: flags === 3,
    ...(sequence === undefined ? {} : { sequence }),
  };
}

function createSession(
  socket: WebSocket,
  operations: {
    readonly send: (frame: Buffer, final: boolean) => Promise<void>;
    readonly finish: () => Promise<void>;
  },
): CloudAsrSession {
  return {
    sendPcm16: operations.send,
    finish: operations.finish,
    close: () => closeWebSocket(socket),
  };
}

function utteranceLanguage(value: Record<string, unknown>): Partial<{ language: string }> {
  if (!isRecord(value.additions) || typeof value.additions.lid_lang !== "string") return {};
  return { language: value.additions.lid_lang };
}

function stringOption(options: CloudAsrConnectOptions, key: string): string | undefined {
  const value = options.providerOptions[key];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function booleanOption(options: CloudAsrConnectOptions, key: string): boolean | undefined {
  const value = options.providerOptions[key];
  return typeof value === "boolean" ? value : undefined;
}

function numberOption(options: CloudAsrConnectOptions, key: string): number | undefined {
  return numericValue(options.providerOptions[key]);
}

function numericValue(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() && Number.isFinite(Number(value))) return Number(value);
  return undefined;
}

function numberField<K extends "audioStartMs" | "audioEndMs">(
  value: number | undefined,
  key: K,
): Partial<Record<K, number>> {
  return value === undefined ? {} : { [key]: value } as Record<K, number>;
}

function requireEnvironment(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Missing environment variable: ${name}`);
  return value;
}

function emitError(emit: (event: CloudAsrEvent) => void, error: Error, raw: unknown): void {
  emit({ type: "provider-error", provider: "volcengine", receivedAtMs: Date.now(), error: error.message, raw });
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function closedError(provider: string, code: number, reason: Buffer): Error {
  return new Error(`${provider} WebSocket closed (${code}: ${reason.toString("utf8") || "no reason"})`);
}
