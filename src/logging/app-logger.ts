import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { closeSync, existsSync, mkdirSync, openSync, readSync, statSync } from "node:fs";
import { appendFile } from "node:fs/promises";
import path from "node:path";

export type AppLogLevel = "debug" | "info" | "warn" | "error";
export type LogJsonValue = null | boolean | number | string | LogJsonValue[] | { readonly [key: string]: LogJsonValue };

export interface AppLogEntry {
  readonly id: string;
  readonly timestamp: string;
  readonly level: AppLogLevel;
  readonly source?: string;
  readonly event?: string;
  readonly message: string;
  readonly details?: LogJsonValue;
}

export class AppLogger {
  private readonly events = new EventEmitter();
  private readonly recentEntries: AppLogEntry[];
  private writeTail: Promise<void> = Promise.resolve();
  private streamFailed = false;
  private closed = false;
  readonly directory: string;
  readonly filePath: string;

  constructor(rootDirectory = process.cwd()) {
    this.directory = path.join(rootDirectory, "logs");
    mkdirSync(this.directory, { recursive: true });
    this.filePath = path.join(this.directory, `${localDateStamp(new Date())}.jsonl`);
    this.recentEntries = readRecentEntries(this.filePath, 500);
  }

  subscribe(listener: (entry: AppLogEntry) => void): () => void {
    this.events.on("entry", listener);
    return () => this.events.off("entry", listener);
  }

  recent(limit = 100): readonly AppLogEntry[] {
    return this.recentEntries.slice(-limit);
  }

  debug(message: string, source?: string, details?: unknown, event?: string): void {
    this.write("debug", message, source, details, event);
  }

  info(message: string, source?: string, details?: unknown, event?: string): void {
    this.write("info", message, source, details, event);
  }

  warn(message: string, source?: string, details?: unknown, event?: string): void {
    this.write("warn", message, source, details, event);
  }

  error(message: string, source?: string, details?: unknown, event?: string): void {
    this.write("error", message, source, details, event);
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await this.writeTail;
  }

  private write(
    level: AppLogLevel,
    message: string,
    source?: string,
    details?: unknown,
    event?: string,
  ): void {
    const entry: AppLogEntry = {
      id: randomUUID(),
      timestamp: new Date().toISOString(),
      level,
      message: redact(message),
      ...(source ? { source } : {}),
      ...(event ? { event } : {}),
      ...(details === undefined ? {} : { details: sanitizeLogValue(details) }),
    };
    this.pushRecent(entry);
    this.events.emit("entry", entry);
    if (!this.closed && !this.streamFailed) {
      this.writeTail = this.writeTail
        .then(() => appendFile(this.filePath, `${JSON.stringify(entry)}\n`, "utf8"))
        .catch((error) => this.handleStreamError(error));
    }
  }

  private pushRecent(entry: AppLogEntry): void {
    this.recentEntries.push(entry);
    if (this.recentEntries.length > 500) {
      this.recentEntries.splice(0, this.recentEntries.length - 500);
    }
  }

  private handleStreamError(error: unknown): void {
    if (this.streamFailed) return;
    this.streamFailed = true;
    const entry: AppLogEntry = {
      id: randomUUID(),
      timestamp: new Date().toISOString(),
      level: "error",
      source: "logger",
      event: "log.persistence.failed",
      message: `Log file persistence disabled: ${redact(errorMessage(error))}`,
      details: sanitizeLogValue(error),
    };
    this.pushRecent(entry);
    this.events.emit("entry", entry);
  }
}

function readRecentEntries(filePath: string, limit: number): AppLogEntry[] {
  if (!existsSync(filePath)) return [];
  let descriptor: number | undefined;
  try {
    const size = statSync(filePath).size;
    const bytesToRead = Math.min(size, 4 * 1024 * 1024);
    const buffer = Buffer.alloc(bytesToRead);
    descriptor = openSync(filePath, "r");
    readSync(descriptor, buffer, 0, bytesToRead, size - bytesToRead);
    const text = buffer.toString("utf8");
    const lines = text.split(/\r?\n/u);
    if (size > bytesToRead) lines.shift();
    return lines
      .filter((line) => line.trim())
      .slice(-limit)
      .flatMap((line) => parseStoredEntry(line));
  } catch {
    return [];
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

function parseStoredEntry(line: string): AppLogEntry[] {
  if (!line.trim()) return [];
  try {
    const value = JSON.parse(line) as unknown;
    if (!isRecord(value) || typeof value.id !== "string" || typeof value.timestamp !== "string"
      || typeof value.message !== "string" || !isLogLevel(value.level)) return [];
    return [{
      id: value.id,
      timestamp: value.timestamp,
      level: value.level,
      message: value.message,
      ...(typeof value.source === "string" ? { source: value.source } : {}),
      ...(typeof value.event === "string" ? { event: value.event } : {}),
      ...(value.details === undefined ? {} : { details: sanitizeLogValue(value.details) }),
    }];
  } catch {
    return [];
  }
}

function sanitizeLogValue(value: unknown, seen = new WeakSet<object>(), depth = 0): LogJsonValue {
  if (depth > 12) return "[MAX_DEPTH]";
  if (value === null || typeof value === "boolean" || typeof value === "number") return value;
  if (typeof value === "string") return redact(value);
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "undefined") return "[UNDEFINED]";
  if (typeof value === "function" || typeof value === "symbol") return String(value);
  if (value instanceof Error) return serializeError(value, seen, depth);
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) {
    if (seen.has(value)) return "[CIRCULAR]";
    seen.add(value);
    return value.map((item) => sanitizeLogValue(item, seen, depth + 1));
  }
  if (typeof value === "object") {
    if (seen.has(value)) return "[CIRCULAR]";
    seen.add(value);
    const output: Record<string, LogJsonValue> = {};
    for (const [key, item] of Object.entries(value)) {
      output[key] = isSensitiveKey(key) ? "[REDACTED]" : sanitizeLogValue(item, seen, depth + 1);
    }
    return output;
  }
  return redact(String(value));
}

function serializeError(error: Error, seen: WeakSet<object>, depth: number): LogJsonValue {
  const candidate = error as Error & {
    readonly code?: unknown;
    readonly status?: unknown;
    readonly statusCode?: unknown;
    readonly providerCode?: unknown;
    readonly request_id?: unknown;
    readonly requestID?: unknown;
    readonly type?: unknown;
    readonly errors?: unknown;
    readonly error?: unknown;
    readonly param?: unknown;
    readonly headers?: unknown;
    readonly body?: unknown;
  };
  return {
    name: error.name,
    message: redact(error.message),
    ...(error.stack ? { stack: redact(error.stack) } : {}),
    ...(candidate.code === undefined ? {} : { code: sanitizeLogValue(candidate.code, seen, depth + 1) }),
    ...(candidate.status === undefined ? {} : { status: sanitizeLogValue(candidate.status, seen, depth + 1) }),
    ...(candidate.statusCode === undefined ? {} : { statusCode: sanitizeLogValue(candidate.statusCode, seen, depth + 1) }),
    ...(candidate.providerCode === undefined ? {} : { providerCode: sanitizeLogValue(candidate.providerCode, seen, depth + 1) }),
    ...(candidate.request_id === undefined && candidate.requestID === undefined ? {} : { requestId: sanitizeLogValue(candidate.request_id ?? candidate.requestID, seen, depth + 1) }),
    ...(candidate.type === undefined ? {} : { type: sanitizeLogValue(candidate.type, seen, depth + 1) }),
    ...(candidate.errors === undefined ? {} : { errors: sanitizeLogValue(candidate.errors, seen, depth + 1) }),
    ...(candidate.error === undefined ? {} : { error: sanitizeLogValue(candidate.error, seen, depth + 1) }),
    ...(candidate.param === undefined ? {} : { param: sanitizeLogValue(candidate.param, seen, depth + 1) }),
    ...(candidate.headers === undefined ? {} : { headers: sanitizeHeaders(candidate.headers, seen, depth + 1) }),
    ...(candidate.body === undefined ? {} : { body: sanitizeLogValue(candidate.body, seen, depth + 1) }),
    ...(error.cause === undefined ? {} : { cause: sanitizeLogValue(error.cause, seen, depth + 1) }),
  };
}

function sanitizeHeaders(value: unknown, seen: WeakSet<object>, depth: number): LogJsonValue {
  if (typeof Headers !== "undefined" && value instanceof Headers) {
    return sanitizeLogValue(Object.fromEntries(value.entries()), seen, depth);
  }
  return sanitizeLogValue(value, seen, depth);
}

function redact(value: string): string {
  return value
    .replace(/\bsk-[A-Za-z0-9_-]{8,}\b/gu, "[REDACTED]")
    .replace(/\bBearer\s+[A-Za-z0-9._~+\/-]+=*\b/giu, "Bearer [REDACTED]");
}

function isSensitiveKey(key: string): boolean {
  return /^(?:authorization|api[-_]?key|secret|password|access[-_]?token|refresh[-_]?token|token)$/iu.test(key);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isLogLevel(value: unknown): value is AppLogLevel {
  return value === "debug" || value === "info" || value === "warn" || value === "error";
}

function localDateStamp(date: Date): string {
  return [date.getFullYear(), date.getMonth() + 1, date.getDate()]
    .map((part, index) => index === 0 ? String(part) : String(part).padStart(2, "0"))
    .join("-");
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
