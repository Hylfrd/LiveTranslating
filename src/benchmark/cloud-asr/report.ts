import { mean, percentile } from "../metrics.js";
import {
  characterErrorMetrics,
  mixedErrorMetrics,
  revisionErasure,
  wordErrorMetricsForCloud,
} from "./evaluation.js";
import { redactBenchmarkText } from "./redaction.js";
import type { CloudAsrBenchmarkConfig, TimedCloudAsrEvent } from "./types.js";

export function createReport(
  config: CloudAsrBenchmarkConfig,
  referenceText: string,
  events: readonly TimedCloudAsrEvent[],
  connectLatencyMs: number,
  runWallMs: number,
  pacing: {
    readonly audioSentMs: number;
    readonly latenessMs: readonly number[];
    readonly scheduleShiftMs: number;
  },
  failure?: Error,
) {
  const finalByUtterance = new Map<string, string>();
  const order: string[] = [];
  for (const event of events) {
    if (event.type !== "final" || !event.text) continue;
    const key = event.utteranceId ?? `final-${order.length}`;
    if (!finalByUtterance.has(key)) order.push(key);
    finalByUtterance.set(key, event.text.trim());
  }
  const hypothesisText = order.map((key) => finalByUtterance.get(key) ?? "").filter(Boolean).join(" ");
  const partials = events.filter((event) => event.type === "partial" && Boolean(event.text));
  let erasedCharacters = 0;
  const lastPartialByUtterance = new Map<string, string>();
  for (const event of partials) {
    const key = event.utteranceId ?? "default";
    const previous = lastPartialByUtterance.get(key) ?? "";
    erasedCharacters += revisionErasure(previous, event.text ?? "");
    lastPartialByUtterance.set(key, event.text ?? "");
  }
  const finalEvents = events.filter((event) => event.type === "final");
  const finalLags = finalEvents.flatMap((event) =>
    event.audioEndMs === undefined
      ? []
      : [Math.max(0, event.elapsedWallMs - connectLatencyMs - event.audioEndMs)],
  );
  const duplicateFinals = finalEvents.reduce((count, event, index) => {
    if (index === 0) return count;
    return normalize(event.text ?? "") === normalize(finalEvents[index - 1]?.text ?? "") ? count + 1 : count;
  }, 0);
  return {
    schemaVersion: 1,
    createdAt: new Date().toISOString(),
    provider: config.provider,
    outcome: failure
      ? { ok: false, error: { name: failure.name, message: redactBenchmarkText(failure.message) } }
      : { ok: true },
    input: {
      name: config.name,
      path: config.input,
      startSeconds: config.startSeconds,
      durationSeconds: config.durationSeconds,
      frameMs: config.frameMs,
      language: config.language ?? "auto",
    },
    timing: {
      connectLatencyMs: round(connectLatencyMs),
      runWallMs: round(runWallMs),
      firstPartialMs: partials[0]?.elapsedWallMs,
      firstFinalMs: finalEvents[0]?.elapsedWallMs,
      finalizationLag: summarize(finalLags),
      audioSentMs: round(pacing.audioSentMs),
      pacingLateness: summarize(pacing.latenessMs),
      pacingScheduleShiftMs: round(pacing.scheduleShiftMs),
    },
    events: {
      total: events.length,
      rawMessages: events.filter((event) => event.type === "raw").length,
      partials: partials.length,
      finals: finalEvents.length,
      providerErrors: events.filter((event) => event.type === "provider-error").length,
      duplicateFinals,
      erasedCharacters,
      partialErasurePerUpdate: partials.length > 0 ? erasedCharacters / partials.length : 0,
    },
    accuracy: {
      wer: wordErrorMetricsForCloud(referenceText, hypothesisText),
      cer: characterErrorMetrics(referenceText, hypothesisText),
      mer: mixedErrorMetrics(referenceText, hypothesisText),
    },
    referenceText,
    hypothesisText,
  };
}

export function renderReportMarkdown(report: ReturnType<typeof createReport>): string {
  const percent = (value: number) => `${(value * 100).toFixed(2)}%`;
  return [
    `# Cloud ASR Benchmark: ${report.input.name}`,
    "",
    `- Provider: ${report.provider}`,
    `- Outcome: ${report.outcome.ok ? "success" : `failed: ${report.outcome.error?.message ?? "unknown error"}`}`,
    `- Audio: ${report.input.path}`,
    `- Clip: ${report.input.startSeconds}s + ${report.input.durationSeconds}s`,
    `- Frame: ${report.input.frameMs}ms PCM16LE / 16kHz / mono`,
    "",
    "## Results",
    "",
    `- First partial: ${report.timing.firstPartialMs ?? "n/a"} ms`,
    `- First final: ${report.timing.firstFinalMs ?? "n/a"} ms`,
    `- Final lag P50/P95: ${report.timing.finalizationLag.p50Ms ?? "n/a"} / ${report.timing.finalizationLag.p95Ms ?? "n/a"} ms`,
    `- Pacing lateness P50/P95: ${report.timing.pacingLateness.p50Ms ?? "n/a"} / ${report.timing.pacingLateness.p95Ms ?? "n/a"} ms`,
    `- WER: ${percent(report.accuracy.wer.errorRate)}`,
    `- CER: ${percent(report.accuracy.cer.errorRate)}`,
    `- MER: ${percent(report.accuracy.mer.errorRate)}`,
    `- Partials/finals/errors: ${report.events.partials} / ${report.events.finals} / ${report.events.providerErrors}`,
    `- Duplicate finals: ${report.events.duplicateFinals}`,
    `- Partial erasure per update: ${report.events.partialErasurePerUpdate.toFixed(3)} chars`,
    "",
    "## Reference",
    "",
    report.referenceText,
    "",
    "## Hypothesis",
    "",
    report.hypothesisText,
    "",
  ].join("\n");
}

function summarize(values: readonly number[]) {
  return {
    count: values.length,
    meanMs: round(mean(values) ?? 0),
    p50Ms: percentile(values, 0.5),
    p95Ms: percentile(values, 0.95),
    maxMs: values.length > 0 ? Math.max(...values) : undefined,
  };
}

function normalize(text: string): string {
  return text.normalize("NFKC").toLocaleLowerCase("en").replace(/[\s\p{P}\p{S}]+/gu, "");
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}
