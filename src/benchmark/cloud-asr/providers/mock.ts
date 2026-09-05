import type {
  CloudAsrAdapter,
  CloudAsrConnectOptions,
  CloudAsrEvent,
  CloudAsrSession,
} from "../types.js";

export class MockCloudAsrAdapter implements CloudAsrAdapter {
  readonly id = "mock" as const;
  readonly requiredEnvironment: readonly string[] = [];
  readonly recommendedFrameMs = [100] as const;

  async connect(
    options: CloudAsrConnectOptions,
    emit: (event: CloudAsrEvent) => void,
  ): Promise<CloudAsrSession> {
    const transcript = typeof options.providerOptions.transcript === "string"
      ? options.providerOptions.transcript
      : "hello world";
    const chunks = Math.max(2, Math.ceil(transcript.length / 4));
    let receivedBytes = 0;
    let emittedChunks = 0;
    emit({ type: "session-ready", provider: this.id, receivedAtMs: Date.now(), raw: { mock: true } });
    return {
      sendPcm16: async (frame) => {
        options.signal.throwIfAborted();
        receivedBytes += frame.length;
        const audioMs = receivedBytes / 32;
        const desiredChunks = Math.min(chunks, Math.floor(audioMs / 400));
        if (desiredChunks > emittedChunks) {
          emittedChunks = desiredChunks;
          const visibleCharacters = Math.ceil(transcript.length * emittedChunks / chunks);
          const preview = transcript.slice(0, visibleCharacters);
          emit({
            type: "partial",
            provider: this.id,
            receivedAtMs: Date.now(),
            utteranceId: "mock-utterance",
            revision: emittedChunks,
            stableText: preview,
            unstableText: "",
            text: preview,
            audioEndMs: audioMs,
            raw: { mock: true, preview },
          });
        }
      },
      finish: async () => {
        emit({
          type: "final",
          provider: this.id,
          receivedAtMs: Date.now(),
          utteranceId: "mock-utterance",
          revision: emittedChunks + 1,
          text: transcript,
          audioStartMs: 0,
          audioEndMs: receivedBytes / 32,
          raw: { mock: true, transcript },
        });
        emit({ type: "session-finished", provider: this.id, receivedAtMs: Date.now(), raw: { mock: true } });
      },
      close: async () => undefined,
    };
  }
}
