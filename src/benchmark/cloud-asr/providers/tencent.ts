import { createHmac, randomInt, randomUUID } from "node:crypto";

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

const HOST = "asr.cloud.tencent.com";

export class TencentCloudAsrAdapter implements CloudAsrAdapter {
  readonly id = "tencent" as const;
  readonly requiredEnvironment = [
    "TENCENTCLOUD_APP_ID",
    "TENCENTCLOUD_SECRET_ID",
    "TENCENTCLOUD_SECRET_KEY",
  ] as const;
  readonly recommendedFrameMs = [40, 200] as const;

  async connect(
    options: CloudAsrConnectOptions,
    emit: (event: CloudAsrEvent) => void,
  ): Promise<CloudAsrSession> {
    const appId = requireEnvironment("TENCENTCLOUD_APP_ID");
    const secretId = requireEnvironment("TENCENTCLOUD_SECRET_ID");
    const secretKey = requireEnvironment("TENCENTCLOUD_SECRET_KEY");
    const sessionToken = process.env.TENCENTCLOUD_SESSION_TOKEN?.trim();
    const timestamp = Math.floor(Date.now() / 1000);
    const voiceId = randomUUID();
    const query: Record<string, string | number> = {
      secretid: secretId,
      timestamp,
      expired: timestamp + 24 * 60 * 60,
      nonce: randomInt(100_000_000, 1_000_000_000),
      voice_id: voiceId,
      engine_model_type: stringOption(options, "engineModelType") ?? "16k_zh_en_2.0",
      voice_format: 1,
      needvad: 1,
      filter_dirty: 0,
      filter_modal: 0,
      filter_punc: 0,
      convert_num_mode: 1,
      sentence_strategy: 0,
      result_mod: 1,
      speaker_diarization: 0,
      ...(sessionToken ? { token: sessionToken } : {}),
    };
    const signPath = `${HOST}/asr/v2/${appId}?${sortedQuery(query)}`;
    const signature = createHmac("sha1", secretKey).update(signPath).digest("base64");
    const endpoint = stringOption(options, "endpoint")
      ?? `wss://${signPath}&signature=${encodeURIComponent(signature)}`;
    const ready = deferred<void>();
    const finished = deferred<void>();
    const revisions = new Map<string, number>();
    const finalTexts = new Map<string, string>();
    let readyEmitted = false;
    let providerFailure: Error | undefined;
    let completed = false;
    const socket = createWebSocket(endpoint, {}, options.signal);

    socket.on("message", (data) => {
      let raw: unknown;
      try {
        raw = parseJsonMessage(data);
      } catch (error) {
        providerFailure = new Error(`Tencent returned invalid JSON: ${errorMessage(error)}`);
        ready.reject(providerFailure);
        finished.reject(providerFailure);
        emitError(emit, providerFailure, { dataType: typeof data });
        return;
      }
      if (!isRecord(raw)) return;
      emit({ type: "raw", provider: this.id, receivedAtMs: Date.now(), raw });
      const code = numericValue(raw.code) ?? 0;
      if (code !== 0) {
        providerFailure = new Error(stringValue(raw.message) ?? `Tencent ASR error ${code}`);
        ready.reject(providerFailure);
        finished.reject(providerFailure);
        emitError(emit, providerFailure, raw);
        return;
      }
      if (!readyEmitted) {
        readyEmitted = true;
        ready.resolve();
        emit({ type: "session-ready", provider: this.id, receivedAtMs: Date.now(), raw });
      }
      const sentences = isRecord(raw.sentences) ? raw.sentences : undefined;
      const sentenceList = sentences && Array.isArray(sentences.sentence_list)
        ? sentences.sentence_list
        : [];
      for (const value of sentenceList) {
        if (!isRecord(value)) continue;
        const sentenceId = String(value.sentence_id ?? "current");
        const text = stringValue(value.sentence) ?? "";
        const final = numericValue(value.sentence_type) === 1;
        if (final && finalTexts.get(sentenceId) === text) continue;
        if (final) finalTexts.set(sentenceId, text);
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
          ...numberField(value.start_time, "audioStartMs"),
          ...numberField(value.end_time, "audioEndMs"),
          raw,
        });
      }
      if (numericValue(raw.final) === 1) {
        completed = true;
        finished.resolve();
        emit({ type: "session-finished", provider: this.id, receivedAtMs: Date.now(), raw });
      }
    });
    socket.on("error", (error) => {
      providerFailure = error;
      ready.reject(error);
      finished.reject(error);
      emitError(emit, error, { socket: "error" });
    });
    socket.on("close", (code, reason) => {
      if (completed || providerFailure) return;
      providerFailure = closedError("Tencent", code, reason);
      ready.reject(providerFailure);
      finished.reject(providerFailure);
      emitError(emit, providerFailure, { socket: "close", code, reason: reason.toString("utf8") });
    });

    try {
      await waitForOpen(socket, options.signal);
      await withTimeout(ready.promise, 10_000, "Tencent session ready");
    } catch (error) {
      await closeWebSocket(socket);
      throw error;
    }
    return createSession(socket, {
      send: (frame) => sendWebSocket(socket, frame),
      finish: async () => {
        if (providerFailure) throw providerFailure;
        await sendWebSocket(socket, JSON.stringify({ type: "end" }));
        await withTimeout(finished.promise, 30_000, "Tencent session finish");
      },
    });
  }
}

function sortedQuery(query: Readonly<Record<string, string | number>>): string {
  return Object.keys(query)
    .sort()
    .map((key) => `${key}=${query[key]}`)
    .join("&");
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

function stringOption(options: CloudAsrConnectOptions, key: string): string | undefined {
  const value = options.providerOptions[key];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function numberField<K extends "audioStartMs" | "audioEndMs">(
  value: unknown,
  key: K,
): Partial<Record<K, number>> {
  const number = numericValue(value);
  return number === undefined ? {} : { [key]: number } as Record<K, number>;
}

function numericValue(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() && Number.isFinite(Number(value))) return Number(value);
  return undefined;
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
  emit({ type: "provider-error", provider: "tencent", receivedAtMs: Date.now(), error: error.message, raw });
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function closedError(provider: string, code: number, reason: Buffer): Error {
  return new Error(`${provider} WebSocket closed (${code}: ${reason.toString("utf8") || "no reason"})`);
}
