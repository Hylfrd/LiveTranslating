import { EventEmitter } from "node:events";
import { createWriteStream, mkdirSync, type WriteStream } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";

export type AppLogLevel = "debug" | "info" | "warn" | "error";

export interface AppLogEntry {
  readonly id: string;
  readonly timestamp: string;
  readonly level: AppLogLevel;
  readonly source?: string;
  readonly message: string;
}

export class AppLogger {
  private readonly events = new EventEmitter();
  private readonly recentEntries: AppLogEntry[] = [];
  private stream: WriteStream | undefined;
  private streamFailed = false;
  private closed = false;

  constructor(rootDirectory = process.cwd()) {
    try {
      const logDirectory = path.join(rootDirectory, "logs");
      mkdirSync(logDirectory, { recursive: true });
      const date = new Date().toISOString().slice(0, 10);
      this.stream = createWriteStream(path.join(logDirectory, `${date}.jsonl`), {
        flags: "a",
        encoding: "utf8",
      });
      this.stream.on("error", (error) => this.handleStreamError(error));
    } catch (error) {
      this.handleStreamError(error);
    }
  }

  subscribe(listener: (entry: AppLogEntry) => void): () => void {
    this.events.on("entry", listener);
    return () => this.events.off("entry", listener);
  }

  recent(limit = 100): readonly AppLogEntry[] {
    return this.recentEntries.slice(-limit);
  }

  debug(message: string, source?: string): void {
    this.write("debug", message, source);
  }

  info(message: string, source?: string): void {
    this.write("info", message, source);
  }

  warn(message: string, source?: string): void {
    this.write("warn", message, source);
  }

  error(message: string, source?: string): void {
    this.write("error", message, source);
  }

  async close(): Promise<void> {
    if (this.closed) {
      return;
    }
    this.closed = true;
    const stream = this.stream;
    if (!stream || stream.closed || stream.destroyed) {
      return;
    }
    await new Promise<void>((resolve) => {
      let settled = false;
      const done = () => {
        if (settled) {
          return;
        }
        settled = true;
        stream.off("close", done);
        stream.off("error", done);
        resolve();
      };
      stream.once("close", done);
      stream.once("error", done);
      try {
        stream.end(done);
      } catch (error) {
        this.handleStreamError(error);
        done();
      }
    });
  }

  private write(level: AppLogLevel, message: string, source?: string): void {
    const entry: AppLogEntry = {
      id: randomUUID(),
      timestamp: new Date().toISOString(),
      level,
      message: redact(message),
      ...(source ? { source } : {}),
    };
    this.recentEntries.push(entry);
    if (this.recentEntries.length > 500) {
      this.recentEntries.splice(0, this.recentEntries.length - 500);
    }
    this.events.emit("entry", entry);
    const stream = this.stream;
    if (!this.closed && stream && !this.streamFailed && !stream.destroyed) {
      try {
        stream.write(`${JSON.stringify(entry)}\n`);
      } catch (error) {
        this.handleStreamError(error);
      }
    }
  }

  private handleStreamError(error: unknown): void {
    if (this.streamFailed) {
      return;
    }
    this.streamFailed = true;
    const entry: AppLogEntry = {
      id: randomUUID(),
      timestamp: new Date().toISOString(),
      level: "error",
      source: "logger",
      message: `Log file persistence disabled: ${redact(errorMessage(error))}`,
    };
    this.recentEntries.push(entry);
    if (this.recentEntries.length > 500) {
      this.recentEntries.splice(0, this.recentEntries.length - 500);
    }
    this.events.emit("entry", entry);
  }
}

function redact(value: string): string {
  return value.replace(/\bsk-[A-Za-z0-9_-]{8,}\b/g, "[REDACTED]");
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
