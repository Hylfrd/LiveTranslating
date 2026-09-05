import { mkdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { MockCloudAsrAdapter } from "./providers/mock.js";
import { runProtocolSelfTests } from "./protocol-selftest.js";
import { loadReference } from "./reference.js";
import { sanitizeBenchmarkValue } from "./redaction.js";
import { runCloudAsrBenchmark } from "./runner.js";
import { characterErrorMetrics, wordErrorMetricsForCloud } from "./evaluation.js";
import type { CloudAsrAdapter, CloudAsrBenchmarkConfig } from "./types.js";

const outputDirectory = path.join(os.tmpdir(), `live-translating-cloud-asr-selftest-${process.pid}`);
await mkdir(outputDirectory, { recursive: true });
const transcript = "中文 mixed language benchmark works";
const config: CloudAsrBenchmarkConfig = {
  name: "cloud-asr-selftest",
  provider: "mock",
  input: "synthetic:silence",
  referenceText: transcript,
  outputDirectory,
  startSeconds: 0,
  durationSeconds: 2,
  frameMs: 100,
  providerOptions: { transcript },
};
const report = await runCloudAsrBenchmark(config, new MockCloudAsrAdapter());
if (report.accuracy.mer.errorRate !== 0 || report.events.finals !== 1 || report.events.partials < 1) {
  throw new Error(`Cloud ASR self-test failed: ${JSON.stringify(report)}`);
}
const eventLines = (await readFile(path.join(outputDirectory, "events.jsonl"), "utf8")).trim().split("\n");
if (eventLines.length !== report.events.total) {
  throw new Error(`Raw event count mismatch (${eventLines.length} != ${report.events.total})`);
}
const protocols = await runProtocolSelfTests();
assertEditMetrics();
await assertCaptionOverlap(outputDirectory);
const residualFrameFinalLagMs = await assertResidualFramePacing(config, outputDirectory);
assertRedaction();
const failureReportWritten = await assertFailureReport(outputDirectory);
console.log(JSON.stringify({
  ok: true,
  outputDirectory,
  events: report.events,
  accuracy: report.accuracy,
  protocols,
  residualFrameFinalLagMs,
  failureReportWritten,
}));

function assertEditMetrics(): void {
  if (wordErrorMetricsForCloud("one two", "one three").editDistance !== 1) {
    throw new Error("Word substitution metric is incorrect");
  }
  if (wordErrorMetricsForCloud("one two", "one").editDistance !== 1) {
    throw new Error("Word deletion metric is incorrect");
  }
  if (wordErrorMetricsForCloud("one", "one two").editDistance !== 1) {
    throw new Error("Word insertion metric is incorrect");
  }
  const longText = "中文测试".repeat(5000);
  if (characterErrorMetrics(longText, longText).editDistance !== 0) {
    throw new Error("Long transcript metric is incorrect");
  }
}

async function assertCaptionOverlap(parentDirectory: string): Promise<void> {
  const vttPath = path.join(parentDirectory, "overlap.vtt");
  await writeFile(vttPath, [
    "WEBVTT",
    "",
    "00:00:00.000 --> 00:00:01.000",
    "yes",
    "",
    "00:00:02.000 --> 00:00:03.000",
    "yes",
    "",
    "00:00:03.000 --> 00:00:05.000",
    "hello",
    "",
    "00:00:04.000 --> 00:00:06.000",
    "hello world",
    "",
  ].join("\n"), "utf8");
  const { referenceText: _referenceText, ...withoutInlineReference } = config;
  const reference = await loadReference({
    ...withoutInlineReference,
    reference: vttPath,
    startSeconds: 0,
    durationSeconds: 10,
  });
  if (reference.text !== "yes yes hello world") {
    throw new Error(`Caption overlap normalization is incorrect: ${reference.text}`);
  }
}

async function assertResidualFramePacing(
  baseConfig: CloudAsrBenchmarkConfig,
  parentDirectory: string,
): Promise<number> {
  const report = await runCloudAsrBenchmark({
    ...baseConfig,
    durationSeconds: 2.05,
    outputDirectory: path.join(parentDirectory, "residual-frame"),
  }, new MockCloudAsrAdapter());
  const lag = report.timing.finalizationLag.p95Ms ?? Number.POSITIVE_INFINITY;
  if (lag > 50) throw new Error(`Residual frame added ${lag} ms of artificial finalization lag`);
  return Math.round(lag * 100) / 100;
}

function assertRedaction(): void {
  const value = sanitizeBenchmarkValue({
    authorization: "Bearer very-secret-value",
    nested: { signature: "signed-secret", url: "wss://example.test?signature=secret-value" },
  });
  const serialized = JSON.stringify(value);
  if (serialized.includes("very-secret") || serialized.includes("signed-secret") || serialized.includes("secret-value")) {
    throw new Error(`Credential redaction failed: ${serialized}`);
  }
}

async function assertFailureReport(parentDirectory: string): Promise<boolean> {
  const failedOutput = path.join(parentDirectory, "expected-failure");
  const failingAdapter: CloudAsrAdapter = {
    id: "mock",
    requiredEnvironment: [],
    recommendedFrameMs: [100],
    connect: async () => { throw new Error("expected connection failure"); },
  };
  try {
    await runCloudAsrBenchmark({ ...config, outputDirectory: failedOutput }, failingAdapter);
    throw new Error("Expected benchmark failure was not raised");
  } catch (error) {
    if (!String(error).includes("report saved")) throw error;
  }
  const failureReport = JSON.parse(await readFile(path.join(failedOutput, "report.json"), "utf8")) as {
    outcome?: { ok?: boolean; error?: { message?: string } };
  };
  if (failureReport.outcome?.ok !== false || failureReport.outcome.error?.message !== "expected connection failure") {
    throw new Error(`Failure report is incomplete: ${JSON.stringify(failureReport.outcome)}`);
  }
  return true;
}
