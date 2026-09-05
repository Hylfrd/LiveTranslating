import WebSocket from "ws";

export function createWebSocket(
  url: string,
  headers: Readonly<Record<string, string>>,
  signal: AbortSignal,
): WebSocket {
  const socket = new WebSocket(url, { headers });
  const abort = () => socket.terminate();
  signal.addEventListener("abort", abort, { once: true });
  socket.once("close", () => signal.removeEventListener("abort", abort));
  return socket;
}

export function waitForOpen(socket: WebSocket, signal: AbortSignal, timeoutMs = 10_000): Promise<void> {
  if (socket.readyState === WebSocket.OPEN) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      socket.terminate();
      reject(new Error(`WebSocket connection timed out after ${timeoutMs} ms`));
    }, timeoutMs);
    const cleanup = () => {
      clearTimeout(timer);
      socket.off("open", opened);
      socket.off("error", failed);
      socket.off("close", closed);
      signal.removeEventListener("abort", aborted);
    };
    const opened = () => { cleanup(); resolve(); };
    const failed = (error: Error) => { cleanup(); reject(error); };
    const closed = (code: number, reason: Buffer) => {
      cleanup();
      reject(new Error(`WebSocket closed before opening (${code}: ${reason.toString("utf8") || "no reason"})`));
    };
    const aborted = () => { cleanup(); reject(signal.reason ?? new Error("WebSocket connection aborted")); };
    socket.once("open", opened);
    socket.once("error", failed);
    socket.once("close", closed);
    signal.addEventListener("abort", aborted, { once: true });
  });
}

export function sendWebSocket(socket: WebSocket, data: string | Buffer): Promise<void> {
  return new Promise((resolve, reject) => {
    if (socket.readyState !== WebSocket.OPEN) {
      reject(new Error(`WebSocket is not open (state ${socket.readyState})`));
      return;
    }
    socket.send(data, (error) => error ? reject(error) : resolve());
  });
}

export function closeWebSocket(socket: WebSocket): Promise<void> {
  if (socket.readyState === WebSocket.CLOSED) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      socket.terminate();
      resolve();
    }, 2000);
    socket.once("close", () => {
      clearTimeout(timer);
      resolve();
    });
    if (socket.readyState === WebSocket.OPEN) socket.close(1000);
    else socket.terminate();
  });
}

export interface Deferred<T> {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
  readonly reject: (error: unknown) => void;
}

export function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((accept, decline) => {
    resolve = accept;
    reject = decline;
  });
  void promise.catch(() => undefined);
  return { promise, resolve, reject };
}

export async function withTimeout<T>(promise: Promise<T>, milliseconds: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${milliseconds} ms`)), milliseconds);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer!);
  }
}

export function parseJsonMessage(data: WebSocket.RawData): unknown {
  const text = Buffer.isBuffer(data)
    ? data.toString("utf8")
    : Array.isArray(data)
      ? Buffer.concat(data).toString("utf8")
      : Buffer.from(data as ArrayBuffer).toString("utf8");
  return JSON.parse(text);
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
