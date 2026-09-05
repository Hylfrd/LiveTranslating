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

const DEFAULT_MODEL = "qwen-audio-3.0-asr-flash-streaming";

export class AlibabaQwenAudioAdapter implements CloudAsrAdapter {
  readonly id = "alibaba-qwen-audio" as const;
  readonly requiredEnvironment = ["DASHSCOPE_API_KEY", "DASHSCOPE_WORKSPACE_ID"] as const;
  readonly recommendedFrameMs = [100] as const;

  async connect(
    options: CloudAsrConnectOptions,
    emit: (event: CloudAsrEvent) => void,
  ): Promise<CloudAsrSession> {
    const apiKey = requireEnvironment("DASHSCOPE_API_KEY");
    const workspaceId = requireEnvironment("DASHSCOPE_WORKSPACE_ID");
    const endpoint = stringOption(options, "endpoint")
      ?? `wss://${workspaceId}.cn-beijing.maas.aliyuncs.com/api-ws/v1/inference`;
    const taskId = randomUUID();
    const started = deferred<void>();
    const finished = deferred<void>();
    const revisions = new Map<string, number>();
    let providerFailure: Error | undefined;
    let completed = false;
    const socket = createWebSocket(endpoint, { Authorization: `Bearer ${apiKey}` }, options.signal);

    socket.on("message", (data) => {
      let raw: unknown;
      try {
        raw = parseJsonMessage(data);
      } catch (error) {
        providerFailure = new Error(`Alibaba returned invalid JSON: ${errorMessage(error)}`);
        started.reject(providerFailure);
        finished.reject(providerFailure);
        emitError(emit, providerFailure, { dataType: typeof data });
        return;
      }
      if (!isRecord(raw) || !isRecord(raw.header)) return;
      emit({ type: "raw", provider: this.id, receivedAtMs: Date.now(), raw });
      const event = stringValue(raw.header.event);
      if (event === "task-started") {
        started.resolve();
        emit({ type: "session-ready", provider: this.id, receivedAtMs: Date.now(), raw });
        return;
      }
      if (event === "task-finished") {
        completed = true;
        finished.resolve();
        emit({ type: "session-finished", provider: this.id, receivedAtMs: Date.now(), raw });
        return;
      }
      if (event === "task-failed") {
        providerFailure = new Error(stringValue(raw.header.error_message) ?? "Alibaba ASR task failed");
        started.reject(providerFailure);
        finished.reject(providerFailure);
        emitError(emit, providerFailure, raw);
        return;
      }
      if (event !== "result-generated" || !isRecord(raw.payload)) return;
      const output = isRecord(raw.payload.output) ? raw.payload.output : undefined;
      const sentence = output && isRecord(output.sentence) ? output.sentence : undefined;
      if (!sentence) return;
      const sentenceId = String(sentence.sentence_id ?? "");
      if (!sentenceId || sentenceId === "0") return;
      const text = stringValue(sentence.text) ?? "";
      const final = sentence.sentence_end === true;
      const revision = (revisions.get(sentenceId) ?? 0) + 1;
      revisions.set(sentenceId, revision);
      emit({
        type: final ? "final" : "partial",
        provider: this.id,
        receivedAtMs: Date.now(),
        utteranceId: sentenceId,
        revision,
        text,
        ...(final ? { stableText: text } : { unstableText: text }),
        ...numberField(sentence.begin_time, "audioStartMs"),
        ...numberField(sentence.end_time, "audioEndMs"),
        raw,
      });
    });
    socket.on("error", (error) => {
      providerFailure = error;
      started.reject(error);
      finished.reject(error);
      emitError(emit, error, { socket: "error" });
    });
    socket.on("close", (code, reason) => {
      if (completed || providerFailure) return;
      providerFailure = closedError("Alibaba", code, reason);
      started.reject(providerFailure);
      finished.reject(providerFailure);
      emitError(emit, providerFailure, { socket: "close", code, reason: reason.toString("utf8") });
    });

    try {
      await waitForOpen(socket, options.signal);
      await sendWebSocket(socket, JSON.stringify({
        header: { action: "run-task", task_id: taskId, streaming: "duplex" },
        payload: {
          task_group: "audio",
          task: "asr",
          function: "recognition",
          model: stringOption(options, "model") ?? DEFAULT_MODEL,
          parameters: {
            format: "pcm",
            sample_rate: options.sampleRate,
            semantic_punctuation_enabled: booleanOption(options, "semanticPunctuation") ?? false,
            max_sentence_silence: numberOption(options, "maxSentenceSilenceMs") ?? 800,
            heartbeat: true,
            ...languageHints(options),
          },
          input: {},
        },
      }));
      await withTimeout(started.promise, 10_000, "Alibaba task start");
    } catch (error) {
      await closeWebSocket(socket);
      throw error;
    }

    return createSession(socket, {
      send: (frame) => sendWebSocket(socket, frame),
      finish: async () => {
        if (providerFailure) throw providerFailure;
        await sendWebSocket(socket, JSON.stringify({
          header: { action: "finish-task", task_id: taskId, streaming: "duplex" },
          payload: { input: {} },
        }));
        await withTimeout(finished.promise, 30_000, "Alibaba task finish");
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

function languageHints(options: CloudAsrConnectOptions): Record<string, unknown> {
  if (!options.language || options.language === "auto") return {};
  const hints = options.language.split(",").map((value) => value.trim()).filter(Boolean).slice(0, 4);
  return hints.length > 0 ? { language_hints: hints } : {};
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
  const value = options.providerOptions[key];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function numberField<K extends "audioStartMs" | "audioEndMs">(
  value: unknown,
  key: K,
): Partial<Record<K, number>> {
  return typeof value === "number" && Number.isFinite(value) ? { [key]: value } as Record<K, number> : {};
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function requireEnvironment(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Missing environment variable: ${name}`);
  return value;
}

function emitError(emit: (event: CloudAsrEvent) => void, error: Error, raw: unknown): void {
  emit({ type: "provider-error", provider: "alibaba-qwen-audio", receivedAtMs: Date.now(), error: error.message, raw });
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function closedError(provider: string, code: number, reason: Buffer): Error {
  return new Error(`${provider} WebSocket closed (${code}: ${reason.toString("utf8") || "no reason"})`);
}
