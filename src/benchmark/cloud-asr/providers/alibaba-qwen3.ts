import { randomUUID } from "node:crypto";

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
  parseJsonMessage,
  sendWebSocket,
  waitForOpen,
  withTimeout,
} from "../websocket.js";

export class AlibabaQwen3Adapter implements CloudAsrAdapter {
  readonly id = "alibaba-qwen3" as const;
  readonly requiredEnvironment = ["DASHSCOPE_API_KEY", "DASHSCOPE_WORKSPACE_ID"] as const;
  readonly recommendedFrameMs = [100] as const;

  async connect(
    options: CloudAsrConnectOptions,
    emit: (event: CloudAsrEvent) => void,
  ): Promise<CloudAsrSession> {
    const apiKey = requireEnvironment("DASHSCOPE_API_KEY");
    const workspaceId = requireEnvironment("DASHSCOPE_WORKSPACE_ID");
    const model = stringOption(options, "model") ?? "qwen3-asr-flash-realtime";
    const endpoint = stringOption(options, "endpoint")
      ?? `wss://${workspaceId}.cn-beijing.maas.aliyuncs.com/api-ws/v1/realtime?model=${encodeURIComponent(model)}`;
    const created = deferred<void>();
    const updated = deferred<void>();
    const finished = deferred<void>();
    const revisions = new Map<string, number>();
    const speechTimes = new Map<string, { start?: number; end?: number }>();
    let providerFailure: Error | undefined;
    let completed = false;
    const socket = createWebSocket(endpoint, {
      Authorization: `Bearer ${apiKey}`,
      "OpenAI-Beta": "realtime=v1",
    }, options.signal);

    socket.on("message", (data) => {
      let raw: unknown;
      try {
        raw = parseJsonMessage(data);
      } catch (error) {
        providerFailure = new Error(`Qwen3 returned invalid JSON: ${errorMessage(error)}`);
        created.reject(providerFailure);
        updated.reject(providerFailure);
        finished.reject(providerFailure);
        emitError(emit, providerFailure, { dataType: typeof data });
        return;
      }
      if (!isRecord(raw)) return;
      emit({ type: "raw", provider: this.id, receivedAtMs: Date.now(), raw });
      const type = stringValue(raw.type);
      if (type === "session.created") {
        created.resolve();
      } else if (type === "session.updated") {
        updated.resolve();
        emit({ type: "session-ready", provider: this.id, receivedAtMs: Date.now(), raw });
      } else if (type === "session.finished") {
        completed = true;
        finished.resolve();
        emit({ type: "session-finished", provider: this.id, receivedAtMs: Date.now(), raw });
      } else if (type === "input_audio_buffer.speech_started") {
        const utteranceId = stringValue(raw.item_id) ?? "current";
        const start = numericValue(raw.audio_start_ms);
        speechTimes.set(utteranceId, { ...(start === undefined ? {} : { start }) });
        emit({
          type: "speech-start",
          provider: this.id,
          receivedAtMs: Date.now(),
          utteranceId,
          ...numberField(start, "audioStartMs"),
          raw,
        });
      } else if (type === "input_audio_buffer.speech_stopped") {
        const utteranceId = stringValue(raw.item_id) ?? "current";
        const end = numericValue(raw.audio_end_ms);
        const previous = speechTimes.get(utteranceId) ?? {};
        speechTimes.set(utteranceId, { ...previous, ...(end === undefined ? {} : { end }) });
        emit({
          type: "speech-stop",
          provider: this.id,
          receivedAtMs: Date.now(),
          utteranceId,
          ...numberField(previous.start, "audioStartMs"),
          ...numberField(end, "audioEndMs"),
          raw,
        });
      } else if (type === "conversation.item.input_audio_transcription.text") {
        const utteranceId = stringValue(raw.item_id) ?? "current";
        const stableText = stringValue(raw.text) ?? "";
        const unstableText = stringValue(raw.stash) ?? "";
        const revision = (revisions.get(utteranceId) ?? 0) + 1;
        revisions.set(utteranceId, revision);
        emit({
          type: "partial",
          provider: this.id,
          receivedAtMs: Date.now(),
          utteranceId,
          revision,
          stableText,
          unstableText,
          text: `${stableText}${unstableText}`,
          ...stringField(raw.language, "language"),
          ...speechTimeFields(speechTimes.get(utteranceId)),
          raw,
        });
      } else if (type === "conversation.item.input_audio_transcription.completed") {
        const utteranceId = stringValue(raw.item_id) ?? `final-${revisions.size}`;
        const text = stringValue(raw.transcript) ?? "";
        const revision = (revisions.get(utteranceId) ?? 0) + 1;
        revisions.set(utteranceId, revision);
        emit({
          type: "final",
          provider: this.id,
          receivedAtMs: Date.now(),
          utteranceId,
          revision,
          stableText: text,
          text,
          ...stringField(raw.language, "language"),
          ...speechTimeFields(speechTimes.get(utteranceId), raw),
          raw,
        });
      } else if (type === "error" || type === "conversation.item.input_audio_transcription.failed") {
        providerFailure = new Error(providerError(raw));
        created.reject(providerFailure);
        updated.reject(providerFailure);
        finished.reject(providerFailure);
        emitError(emit, providerFailure, raw);
      }
    });
    socket.on("error", (error) => {
      providerFailure = error;
      created.reject(error);
      updated.reject(error);
      finished.reject(error);
      emitError(emit, error, { socket: "error" });
    });
    socket.on("close", (code, reason) => {
      if (completed || providerFailure) return;
      providerFailure = closedError("Qwen3", code, reason);
      created.reject(providerFailure);
      updated.reject(providerFailure);
      finished.reject(providerFailure);
      emitError(emit, providerFailure, { socket: "close", code, reason: reason.toString("utf8") });
    });

    try {
      await waitForOpen(socket, options.signal);
      await withTimeout(created.promise, 10_000, "Qwen3 session creation");
      await sendWebSocket(socket, JSON.stringify({
        event_id: `event_${randomUUID()}`,
        type: "session.update",
        session: {
          modalities: ["text"],
          input_audio_format: "pcm",
          sample_rate: options.sampleRate,
          turn_detection: {
            type: "server_vad",
            threshold: numberOption(options, "vadThreshold") ?? 0.2,
            silence_duration_ms: numberOption(options, "silenceDurationMs") ?? 800,
          },
          ...languageConfiguration(options),
        },
      }));
      await withTimeout(updated.promise, 10_000, "Qwen3 session update");
    } catch (error) {
      await closeWebSocket(socket);
      throw error;
    }

    return createSession(socket, {
      send: (frame) => sendWebSocket(socket, JSON.stringify({
        event_id: `event_${randomUUID()}`,
        type: "input_audio_buffer.append",
        audio: frame.toString("base64"),
      })),
      finish: async () => {
        if (providerFailure) throw providerFailure;
        await sendWebSocket(socket, JSON.stringify({
          event_id: `event_${randomUUID()}`,
          type: "session.finish",
        }));
        await withTimeout(finished.promise, 30_000, "Qwen3 session finish");
      },
    });
  }
}

function createSession(
  socket: WebSocket,
  operations: { readonly send: (frame: Buffer) => Promise<void>; readonly finish: () => Promise<void> },
): CloudAsrSession {
  return {
    sendPcm16: operations.send,
    finish: operations.finish,
    close: () => closeWebSocket(socket),
  };
}

function languageConfiguration(options: CloudAsrConnectOptions): Record<string, unknown> {
  if (!options.language || options.language === "auto") return {};
  return { input_audio_transcription: { language: options.language } };
}

function stringOption(options: CloudAsrConnectOptions, key: string): string | undefined {
  const value = options.providerOptions[key];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function numberOption(options: CloudAsrConnectOptions, key: string): number | undefined {
  const value = options.providerOptions[key];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
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

function speechTimeFields(
  stored: { readonly start?: number; readonly end?: number } | undefined,
  raw?: Record<string, unknown>,
): Partial<{ audioStartMs: number; audioEndMs: number }> {
  const start = numericValue(raw?.audio_start_ms) ?? stored?.start;
  const end = numericValue(raw?.audio_end_ms) ?? stored?.end;
  return {
    ...numberField(start, "audioStartMs"),
    ...numberField(end, "audioEndMs"),
  };
}

function stringField<K extends "language">(value: unknown, key: K): Partial<Record<K, string>> {
  return typeof value === "string" && value ? { [key]: value } as Record<K, string> : {};
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function requireEnvironment(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Missing environment variable: ${name}`);
  return value;
}

function providerError(raw: Record<string, unknown>): string {
  if (isRecord(raw.error) && typeof raw.error.message === "string") return raw.error.message;
  return typeof raw.message === "string" ? raw.message : "Qwen3 ASR request failed";
}

function emitError(emit: (event: CloudAsrEvent) => void, error: Error, raw: unknown): void {
  emit({ type: "provider-error", provider: "alibaba-qwen3", receivedAtMs: Date.now(), error: error.message, raw });
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function closedError(provider: string, code: number, reason: Buffer): Error {
  return new Error(`${provider} WebSocket closed (${code}: ${reason.toString("utf8") || "no reason"})`);
}
