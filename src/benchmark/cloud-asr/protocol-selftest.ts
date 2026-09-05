import { gzipSync } from "node:zlib";

import { WebSocketServer, type WebSocket } from "ws";

import { AlibabaQwenAudioAdapter } from "./providers/alibaba-qwen-audio.js";
import { AlibabaQwen3Adapter } from "./providers/alibaba-qwen3.js";
import { TencentCloudAsrAdapter } from "./providers/tencent.js";
import { VolcengineAsrAdapter } from "./providers/volcengine.js";
import type { CloudAsrAdapter, CloudAsrEvent } from "./types.js";

export async function runProtocolSelfTests(): Promise<Record<string, number>> {
  return withDummyEnvironment(async () => {
    const results = await Promise.all([
      testAdapter(new AlibabaQwenAudioAdapter(), serveAlibabaQwenAudio),
      testAdapter(new AlibabaQwen3Adapter(), serveAlibabaQwen3),
      testAdapter(new TencentCloudAsrAdapter(), serveTencent),
      testAdapter(new VolcengineAsrAdapter(), serveVolcengine),
    ]);
    const prematureCloseMs = await testPrematureClose();
    return {
      ...Object.fromEntries(results.map((result) => [result.provider, result.events])),
      prematureCloseMs,
    };
  });
}

async function testAdapter(
  adapter: CloudAsrAdapter,
  serve: (socket: WebSocket) => void,
): Promise<{ provider: string; events: number }> {
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await new Promise<void>((resolve, reject) => {
    server.once("listening", resolve);
    server.once("error", reject);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Protocol self-test server has no TCP port");
  server.on("connection", serve);
  const events: CloudAsrEvent[] = [];
  const controller = new AbortController();
  try {
    const session = await adapter.connect({
      sampleRate: 16000,
      frameMs: adapter.id === "tencent" || adapter.id === "volcengine" ? 200 : 100,
      providerOptions: { endpoint: `ws://127.0.0.1:${address.port}` },
      signal: controller.signal,
    }, (event) => events.push(event));
    await session.sendPcm16(Buffer.alloc(adapter.id === "tencent" || adapter.id === "volcengine" ? 6400 : 3200), true);
    await session.finish();
    await session.close();
  } finally {
    controller.abort();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  const types = new Set(events.map((event) => event.type));
  for (const required of ["session-ready", "partial", "final", "session-finished"] as const) {
    if (!types.has(required)) {
      throw new Error(`${adapter.id} protocol self-test did not emit ${required}: ${JSON.stringify(events)}`);
    }
  }
  if (events.filter((event) => event.type === "final").length !== 1) {
    throw new Error(`${adapter.id} protocol self-test emitted duplicate finals: ${JSON.stringify(events)}`);
  }
  return { provider: adapter.id, events: events.length };
}

async function testPrematureClose(): Promise<number> {
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await new Promise<void>((resolve, reject) => {
    server.once("listening", resolve);
    server.once("error", reject);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Premature-close server has no TCP port");
  server.on("connection", (socket) => socket.close(1011, "expected self-test close"));
  const startedAt = performance.now();
  let rejected = false;
  try {
    await new AlibabaQwenAudioAdapter().connect({
      sampleRate: 16000,
      frameMs: 100,
      providerOptions: { endpoint: `ws://127.0.0.1:${address.port}` },
      signal: new AbortController().signal,
    }, () => undefined);
  } catch {
    rejected = true;
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  if (!rejected) throw new Error("Premature WebSocket close unexpectedly connected");
  const elapsed = performance.now() - startedAt;
  if (elapsed > 2000) throw new Error(`Premature close took too long (${elapsed} ms)`);
  return Math.round(elapsed);
}

function serveAlibabaQwenAudio(socket: WebSocket): void {
  socket.on("message", (data, binary) => {
    if (binary) return;
    const message = JSON.parse(data.toString()) as { header?: { action?: string; task_id?: string } };
    const taskId = message.header?.task_id ?? "task";
    if (message.header?.action === "run-task") {
      socket.send(JSON.stringify({ header: { task_id: taskId, event: "task-started", attributes: {} }, payload: {} }));
    } else if (message.header?.action === "finish-task") {
      socket.send(JSON.stringify({
        header: { task_id: taskId, event: "result-generated", attributes: {} },
        payload: { output: { sentence: {
          sentence_id: 1,
          sentence_begin: true,
          sentence_end: false,
          begin_time: 0,
          end_time: null,
          text: "测试",
          words: [],
        } } },
      }));
      socket.send(JSON.stringify({
        header: { task_id: taskId, event: "result-generated", attributes: {} },
        payload: { output: { sentence: {
          sentence_id: 1,
          sentence_begin: false,
          sentence_end: true,
          begin_time: 0,
          end_time: 100,
          text: "测试完成",
          words: [],
        } } },
      }));
      socket.send(JSON.stringify({ header: { task_id: taskId, event: "task-finished", attributes: {} }, payload: {} }));
    }
  });
}

function serveAlibabaQwen3(socket: WebSocket): void {
  socket.send(JSON.stringify({ type: "session.created" }));
  socket.on("message", (data) => {
    const message = JSON.parse(data.toString()) as { type?: string };
    if (message.type === "session.update") {
      socket.send(JSON.stringify({ type: "session.updated" }));
    } else if (message.type === "input_audio_buffer.append") {
      socket.send(JSON.stringify({
        type: "input_audio_buffer.speech_started",
        item_id: "item-1",
        audio_start_ms: 0,
      }));
      socket.send(JSON.stringify({
        type: "conversation.item.input_audio_transcription.text",
        item_id: "item-1",
        text: "测试",
        stash: "中",
        language: "zh",
      }));
    } else if (message.type === "session.finish") {
      socket.send(JSON.stringify({
        type: "input_audio_buffer.speech_stopped",
        item_id: "item-1",
        audio_end_ms: 100,
      }));
      socket.send(JSON.stringify({
        type: "conversation.item.input_audio_transcription.completed",
        item_id: "item-1",
        transcript: "测试中文",
        language: "zh",
      }));
      socket.send(JSON.stringify({ type: "session.finished" }));
    }
  });
}

function serveTencent(socket: WebSocket): void {
  socket.send(JSON.stringify({ code: 0, message: "", voice_id: "voice", final: 0, sentences: { sentence_list: [] } }));
  socket.on("message", (data, binary) => {
    if (binary) {
      socket.send(JSON.stringify({
        code: 0,
        message: "",
        final: 0,
        sentences: { sentence_list: [{ sentence_id: 0, sentence_type: 0, sentence: "测试", start_time: 0, end_time: 100 }] },
      }));
      return;
    }
    const message = JSON.parse(data.toString()) as { type?: string };
    if (message.type === "end") {
      socket.send(JSON.stringify({
        code: 0,
        message: "",
        final: 0,
        sentences: { sentence_list: [{ sentence_id: 0, sentence_type: 1, sentence: "测试完成", start_time: 0, end_time: 200 }] },
      }));
      socket.send(JSON.stringify({
        code: 0,
        message: "",
        final: 1,
        sentences: { sentence_list: [{ sentence_id: 0, sentence_type: 1, sentence: "测试完成", start_time: 0, end_time: 200 }] },
      }));
    }
  });
}

function serveVolcengine(socket: WebSocket): void {
  socket.on("message", (data) => {
    const buffer = Buffer.from(data as Buffer);
    const messageType = buffer[1]! >> 4;
    const flags = buffer[1]! & 0x0f;
    if (messageType !== 2 || flags !== 2) return;
    socket.send(encodeVolcengineResponse({
      audio_info: { duration: 200 },
      result: {
        text: "测试完成",
        utterances: [{ text: "测试完成", start_time: 0, end_time: 200, definite: false }],
      },
    }, 1));
    socket.send(encodeVolcengineResponse({
      audio_info: { duration: 200 },
      result: {
        text: "测试完成",
        utterances: [{ text: "测试完成", start_time: 0, end_time: 200, definite: true }],
      },
    }, 3));
  });
}

function encodeVolcengineResponse(payload: unknown, flags: 1 | 3): Buffer {
  const body = gzipSync(Buffer.from(JSON.stringify(payload), "utf8"));
  const header = Buffer.alloc(12);
  header[0] = 0x11;
  header[1] = 0x90 | flags;
  header[2] = 0x11;
  header[3] = 0;
  header.writeInt32BE(flags === 3 ? -1 : 1, 4);
  header.writeUInt32BE(body.length, 8);
  return Buffer.concat([header, body]);
}

async function withDummyEnvironment<T>(operation: () => Promise<T>): Promise<T> {
  const values: Readonly<Record<string, string>> = {
    DASHSCOPE_API_KEY: "benchmark-placeholder",
    DASHSCOPE_WORKSPACE_ID: "benchmark-placeholder",
    TENCENTCLOUD_APP_ID: "1000000000",
    TENCENTCLOUD_SECRET_ID: "benchmark-placeholder",
    TENCENTCLOUD_SECRET_KEY: "benchmark-placeholder",
    VOLCENGINE_ASR_API_KEY: "benchmark-placeholder",
  };
  const previous = new Map<string, string | undefined>();
  for (const [name, value] of Object.entries(values)) {
    previous.set(name, process.env[name]);
    process.env[name] = value;
  }
  try {
    return await operation();
  } finally {
    for (const [name, value] of previous) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
}
