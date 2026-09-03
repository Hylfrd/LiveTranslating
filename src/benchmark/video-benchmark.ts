import { spawn, spawnSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { FfmpegWhisperSession, type AsrTranscript } from "../asr/ffmpeg-whisper.js";
import { AsrModelManager } from "../asr/model-manager.js";
import { TranscriptAssembler } from "../asr/transcript-assembler.js";
import { config } from "../config.js";
import { matchGlossaryEntries } from "../glossary/glossary-store.js";
import { AppLogger } from "../logging/app-logger.js";
import {
  OpenAICompatibleTranslationProvider,
  TranslationProviderError,
  type TranslationProviderTelemetry,
} from "../translation/provider.js";
import type {
  TranslationModelId,
  TranslationRequest,
  TranslationUsage,
} from "../translation/schema.js";
import { validateTranslation, type TranslationValidationIssue } from "../translation/validator.js";
import {
  mean,
  multisetRecall,
  normalizedNumbers,
  percentile,
  wordErrorMetrics,
} from "./metrics.js";
import { parseVtt, type CaptionCue } from "./vtt.js";

const SAMPLE_RATE = 16000;
const FRAME_SAMPLES = SAMPLE_RATE / 10;
const FRAME_BYTES = FRAME_SAMPLES * Float32Array.BYTES_PER_ELEMENT;
const MODELS: readonly TranslationModelId[] = [
  "hy-mt2-plus",
  "hy-mt2-pro",
  "deepseek-v4-flash",
];

const GLOSSARY = [
  { source: "capital asset pricing model", target: "资本资产定价模型" },
  { source: "efficient portfolio frontier", target: "有效投资组合前沿" },
  { source: "tangency portfolio", target: "切点投资组合" },
  { source: "market portfolio", target: "市场投资组合" },
  { source: "Sharpe ratio", target: "夏普比率" },
  { source: "equity premium", target: "股权风险溢价" },
  { source: "risk-free rate", target: "无风险利率" },
  { source: "standard deviation", target: "标准差" },
  { source: "covariance", target: "协方差" },
  { source: "variance", target: "方差" },
  { source: "leverage", target: "杠杆" },
  { source: "locally weighted regression", target: "局部加权回归" },
  { source: "logistic regression", target: "逻辑回归" },
  { source: "linear regression", target: "线性回归" },
  { source: "Newton's method", target: "牛顿法" },
  { source: "parametric learning algorithm", target: "参数学习算法" },
  { source: "non-parametric learning algorithm", target: "非参数学习算法" },
  { source: "probabilistic interpretation", target: "概率解释" },
  { source: "Bernoulli distribution", target: "伯努利分布" },
  { source: "maximum likelihood estimation", target: "最大似然估计" },
  {
    source: "sigmoid function",
    target: "Sigmoid 函数",
    aliases: ["sigma-weight function", "second-wave function"],
  },
  {
    source: "theta transpose x",
    target: "θ 转置 x",
    aliases: ["transverse x", "the transpose x"],
  },
  { source: "features x", target: "特征 x", aliases: ["future's x"] },
  { source: "gradient descent", target: "梯度下降" },
] as const;

interface CliOptions {
  readonly video: string;
  readonly captions: string;
  readonly name: string;
  readonly outputDirectory: string;
  readonly startSeconds: number;
  readonly durationSeconds: number;
  readonly reviewCount: number;
}

interface BenchmarkSegment {
  readonly index: number;
  readonly startSeconds: number;
  readonly endSeconds: number;
  readonly text: string;
}

interface TranslationMeasurement {
  readonly segmentIndex: number;
  readonly model: TranslationModelId;
  readonly latencyMs: number;
  readonly sourceText: string;
  readonly translation?: string;
  readonly usage?: TranslationUsage;
  readonly validationIssues?: readonly TranslationValidationIssue[];
  readonly glossary: readonly { source: string; target: string }[];
  readonly error?: string;
  readonly providerCode?: string;
}

interface ReviewMeasurement {
  readonly segmentIndex: number;
  readonly candidateModel: TranslationModelId;
  readonly latencyMs: number;
  readonly corrected?: boolean;
  readonly reviewedTranslation?: string;
  readonly usage?: TranslationUsage;
  readonly error?: string;
}

interface AsrRun {
  readonly segments: BenchmarkSegment[];
  readonly rawSegments: BenchmarkSegment[];
  readonly elapsedMs: number;
  readonly decodedSeconds: number;
  readonly backpressureEvents: number;
  readonly backpressureWaitMs: number;
}

const options = await parseOptions(process.argv.slice(2));
await mkdir(options.outputDirectory, { recursive: true });
const logger = new AppLogger(options.outputDirectory);
const provider = new OpenAICompatibleTranslationProvider(config.translation);
const telemetry: TranslationProviderTelemetry[] = [];
const unsubscribeTelemetry = provider.registry.subscribeTelemetry((event) => telemetry.push(event));
let peakNodeRssBytes = process.memoryUsage().rss;
const memoryTimer = setInterval(() => {
  peakNodeRssBytes = Math.max(peakNodeRssBytes, process.memoryUsage().rss);
}, 100);
memoryTimer.unref();

try {
  const missingModels = MODELS.filter((model) => !provider.registry.isConfigured(model));
  if (missingModels.length > 0) {
    throw new Error(`Missing API keys for: ${missingModels.join(", ")}`);
  }
  const media = probeMedia(options.video);
  const captionText = await readFile(options.captions, "utf8");
  const allCues = parseVtt(captionText);
  const clipEnd = options.startSeconds + options.durationSeconds;
  const referenceCues = allCues.filter(
    (cue) => cue.endSeconds > options.startSeconds && cue.startSeconds < clipEnd,
  );
  if (referenceCues.length === 0) {
    throw new Error("No reference captions overlap the selected clip");
  }

  const asr = await transcribeClip(options, logger);
  const referenceText = referenceCues.map((cue) => cue.text).join(" ");
  const hypothesisText = asr.segments.map((segment) => segment.text).join(" ");
  const asrWords = wordErrorMetrics(referenceText, hypothesisText);
  const referenceNumbers = normalizedNumbers(referenceText);
  const hypothesisNumbers = normalizedNumbers(hypothesisText);
  const numberRecall = multisetRecall(referenceNumbers, hypothesisNumbers);
  const numberPrecision = multisetRecall(hypothesisNumbers, referenceNumbers);
  const glossaryReference = GLOSSARY.filter((term) => includesTerm(referenceText, term.source));
  const glossaryHypothesis = glossaryReference.filter((term) => includesTerm(hypothesisText, term.source));

  const translationStartedAt = performance.now();
  const translations = await translateSegments(asr.segments, provider);
  const translationElapsedMs = performance.now() - translationStartedAt;
  const reviews = await reviewHardSegments(
    asr.segments,
    translations,
    provider,
    options.reviewCount,
  );

  const report = {
    schemaVersion: 1,
    createdAt: new Date().toISOString(),
    silentMode: {
      audioOutputOpened: false,
      method: "FFmpeg file decode to Float32 PCM pipe; no playback device",
      validatesNativeLoopbackCapture: false,
    },
    input: {
      name: options.name,
      video: options.video,
      captions: options.captions,
      media,
      clip: {
        startSeconds: options.startSeconds,
        durationSeconds: options.durationSeconds,
      },
    },
    asr: {
      ...asrWords,
      segmentCount: asr.segments.length,
      rawSegmentCount: asr.rawSegments.length,
      referenceCueCount: referenceCues.length,
      elapsedMs: round(asr.elapsedMs),
      realTimeFactor: round(asr.elapsedMs / 1000 / asr.decodedSeconds, 4),
      decodedSeconds: round(asr.decodedSeconds, 3),
      speechRatio: round(speechRatio(asr.segments, options.durationSeconds), 4),
      averageSegmentSeconds: round(
        mean(asr.segments.map((segment) => segment.endSeconds - segment.startSeconds)) ?? 0,
        3,
      ),
      backpressureEvents: asr.backpressureEvents,
      backpressureWaitMs: round(asr.backpressureWaitMs),
      droppedFrames: 0,
      referenceNumberCount: referenceNumbers.length,
      numberRecall,
      numberPrecision,
      numberF1: numberRecall === undefined || numberPrecision === undefined || numberRecall + numberPrecision === 0
        ? undefined
        : round(2 * numberRecall * numberPrecision / (numberRecall + numberPrecision), 4),
      glossaryTermsExpected: glossaryReference.map((term) => term.source),
      glossaryTermRecall: glossaryReference.length > 0
        ? glossaryHypothesis.length / glossaryReference.length
        : undefined,
    },
    translation: {
      elapsedMs: round(translationElapsedMs),
      segmentsPerSecondAcrossAllModels: round(
        translations.filter((item) => item.translation).length / (translationElapsedMs / 1000),
        3,
      ),
      models: Object.fromEntries(
        MODELS.map((model) => [
          model,
          summarizeModel(model, translations, reviews, telemetry),
        ]),
      ),
    },
    process: {
      peakNodeRssBytes,
      peakNodeRssMiB: round(peakNodeRssBytes / 1024 / 1024, 2),
    },
  };

  await Promise.all([
    writeFile(
      path.join(options.outputDirectory, "asr.jsonl"),
      `${asr.segments.map((item) => JSON.stringify(item)).join("\n")}\n`,
      "utf8",
    ),
    writeFile(
      path.join(options.outputDirectory, "asr-raw.jsonl"),
      `${asr.rawSegments.map((item) => JSON.stringify(item)).join("\n")}\n`,
      "utf8",
    ),
    writeFile(
      path.join(options.outputDirectory, "translations.jsonl"),
      `${translations.map((item) => JSON.stringify(item)).join("\n")}\n`,
      "utf8",
    ),
    writeFile(
      path.join(options.outputDirectory, "reviews.jsonl"),
      `${reviews.map((item) => JSON.stringify(item)).join("\n")}\n`,
      "utf8",
    ),
    writeFile(path.join(options.outputDirectory, "report.json"), `${JSON.stringify(report, null, 2)}\n`, "utf8"),
    writeFile(path.join(options.outputDirectory, "report.md"), renderMarkdown(report), "utf8"),
  ]);
  console.log(JSON.stringify({ outputDirectory: options.outputDirectory, report }, null, 2));
} finally {
  clearInterval(memoryTimer);
  unsubscribeTelemetry();
  await logger.close();
}

async function transcribeClip(options: CliOptions, logger: AppLogger): Promise<AsrRun> {
  const modelManager = new AsrModelManager(logger, process.cwd());
  const models = await modelManager.ensureModels();
  const rawTranscripts: AsrTranscript[] = [];
  const transcripts: AsrTranscript[] = [];
  const assembler = new TranscriptAssembler(
    (transcript) => transcripts.push(transcript),
    { idleFlushMs: 0 },
  );
  let asrFailure: Error | undefined;
  const session = new FfmpegWhisperSession(
    "system",
    "en",
    models,
    logger,
    (transcript) => {
      rawTranscripts.push(transcript);
      assembler.push(transcript);
    },
    (error) => {
      asrFailure = error;
    },
  );
  await session.start();
  const originEpochMs = Date.now();
  const startedAt = performance.now();
  let decodedBytes = 0;
  let backpressureEvents = 0;
  let backpressureWaitMs = 0;
  let residual = Buffer.alloc(0);
  const decoder = spawn(
    process.env.FFMPEG_PATH || "ffmpeg",
    [
      "-nostdin",
      "-hide_banner",
      "-loglevel",
      "error",
      "-ss",
      String(options.startSeconds),
      "-t",
      String(options.durationSeconds),
      "-i",
      options.video,
      "-map",
      "0:a:0",
      "-vn",
      "-ac",
      "1",
      "-ar",
      String(SAMPLE_RATE),
      "-f",
      "f32le",
      "pipe:1",
    ],
    { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] },
  );
  let decoderError = "";
  decoder.stderr.setEncoding("utf8");
  decoder.stderr.on("data", (chunk: string) => {
    decoderError += chunk;
  });
  const decoderExit = new Promise<void>((resolve, reject) => {
    decoder.once("error", reject);
    decoder.once("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`FFmpeg decoder exited with ${code}: ${decoderError.trim()}`));
    });
  });

  try {
    for await (const chunk of decoder.stdout) {
      residual = Buffer.concat([residual, chunk as Buffer]);
      while (residual.length >= FRAME_BYTES) {
        const frame = residual.subarray(0, FRAME_BYTES);
        residual = residual.subarray(FRAME_BYTES);
        decodedBytes += frame.length;
        const result = await writeFrameWithBackpressure(session, frame, () => asrFailure);
        backpressureEvents += result.waited ? 1 : 0;
        backpressureWaitMs += result.waitMs;
      }
    }
    await decoderExit;
    const alignedBytes = residual.length - (residual.length % Float32Array.BYTES_PER_ELEMENT);
    if (alignedBytes > 0) {
      const finalFrame = residual.subarray(0, alignedBytes);
      decodedBytes += finalFrame.length;
      const result = await writeFrameWithBackpressure(session, finalFrame, () => asrFailure);
      backpressureEvents += result.waited ? 1 : 0;
      backpressureWaitMs += result.waitMs;
    }
    await session.stop(true);
    assembler.flush();
  } catch (error) {
    decoder.kill();
    assembler.discard();
    await session.stop(false).catch(() => undefined);
    throw error;
  }
  if (asrFailure) {
    throw asrFailure;
  }
  const elapsedMs = performance.now() - startedAt;
  const toSegments = (items: readonly AsrTranscript[]): BenchmarkSegment[] => items
    .map((transcript, index): BenchmarkSegment => ({
      index,
      startSeconds: options.startSeconds + (transcript.speechStartedAt - originEpochMs) / 1000,
      endSeconds: options.startSeconds + (transcript.speechEndedAt - originEpochMs) / 1000,
      text: cleanTranscript(transcript.text),
    }))
    .filter((segment) => segment.text.length > 0);
  const segments = toSegments(transcripts);
  const rawSegments = toSegments(rawTranscripts);
  return {
    segments,
    rawSegments,
    elapsedMs,
    decodedSeconds: decodedBytes / Float32Array.BYTES_PER_ELEMENT / SAMPLE_RATE,
    backpressureEvents,
    backpressureWaitMs,
  };
}

async function writeFrameWithBackpressure(
  session: FfmpegWhisperSession,
  frame: Buffer,
  failure: () => Error | undefined,
): Promise<{ waited: boolean; waitMs: number }> {
  const samples = new Float32Array(frame.buffer, frame.byteOffset, frame.length / 4);
  const startedAt = performance.now();
  let waited = false;
  while (!session.write(samples)) {
    waited = true;
    const error = failure();
    if (error) {
      throw error;
    }
    if (performance.now() - startedAt > 30000) {
      throw new Error("Timed out waiting for Whisper input backpressure");
    }
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
  return { waited, waitMs: waited ? performance.now() - startedAt : 0 };
}

async function translateSegments(
  segments: readonly BenchmarkSegment[],
  provider: OpenAICompatibleTranslationProvider,
): Promise<TranslationMeasurement[]> {
  const contexts = new Map<TranslationModelId, Array<{ source: string; translation: string }>>(
    MODELS.map((model) => [model, []]),
  );
  const measurements: TranslationMeasurement[] = [];

  for (const segment of segments) {
    const glossary = matchingGlossary(segment.text);
    const results = await Promise.all(
      MODELS.map(async (model): Promise<TranslationMeasurement> => {
        const request: TranslationRequest = {
          text: segment.text,
          sourceLanguage: "en",
          targetLanguage: "zh",
          context: (contexts.get(model) ?? []).slice(-4),
          glossary,
          model,
        };
        const startedAt = performance.now();
        try {
          const result = await provider.registry.translate(model, request);
          const validation = validateTranslation(request, result.text);
          return {
            segmentIndex: segment.index,
            model,
            latencyMs: performance.now() - startedAt,
            sourceText: segment.text,
            translation: result.text,
            ...(result.usage ? { usage: result.usage } : {}),
            validationIssues: validation.issues,
            glossary,
          };
        } catch (error) {
          return {
            segmentIndex: segment.index,
            model,
            latencyMs: performance.now() - startedAt,
            sourceText: segment.text,
            glossary,
            error: error instanceof Error ? error.message : String(error),
            ...(error instanceof TranslationProviderError && error.providerCode
              ? { providerCode: error.providerCode }
              : {}),
          };
        }
      }),
    );
    for (const result of results) {
      measurements.push(result);
      if (result.translation) {
        const context = contexts.get(result.model) ?? [];
        contexts.set(
          result.model,
          [...context.slice(-7), { source: result.sourceText, translation: result.translation }],
        );
      }
    }
  }
  return measurements;
}

async function reviewHardSegments(
  segments: readonly BenchmarkSegment[],
  translations: readonly TranslationMeasurement[],
  provider: OpenAICompatibleTranslationProvider,
  reviewCount: number,
): Promise<ReviewMeasurement[]> {
  const selected = [...segments]
    .sort((left, right) => segmentDifficulty(right.text) - segmentDifficulty(left.text))
    .slice(0, reviewCount);
  return Promise.all(
    selected.flatMap((segment) =>
      translations
        .filter((item) => item.segmentIndex === segment.index && item.translation)
        .map(async (candidate): Promise<ReviewMeasurement> => {
          const startedAt = performance.now();
          try {
            const result = await provider.reviewTranslation({
              sourceText: segment.text,
              originalTranslation: candidate.translation ?? "",
              sourceLanguage: "en",
              targetLanguage: "zh",
              context: translations
                .filter(
                  (item) =>
                    item.model === candidate.model &&
                    item.segmentIndex < segment.index &&
                    item.translation,
                )
                .slice(-4)
                .map((item) => ({
                  source: item.sourceText,
                  translation: item.translation ?? "",
                })),
              glossary: [...candidate.glossary],
            });
            return {
              segmentIndex: segment.index,
              candidateModel: candidate.model,
              latencyMs: performance.now() - startedAt,
              corrected: result.corrected,
              reviewedTranslation: result.reviewedTranslation,
              ...(result.usage ? { usage: result.usage } : {}),
            };
          } catch (error) {
            return {
              segmentIndex: segment.index,
              candidateModel: candidate.model,
              latencyMs: performance.now() - startedAt,
              error: error instanceof Error ? error.message : String(error),
            };
          }
        }),
    ),
  );
}

function summarizeModel(
  model: TranslationModelId,
  translations: readonly TranslationMeasurement[],
  reviews: readonly ReviewMeasurement[],
  telemetry: readonly TranslationProviderTelemetry[],
): Record<string, unknown> {
  const items = translations.filter((item) => item.model === model);
  const successful = items.filter((item) => item.translation);
  const latencies = successful.map((item) => item.latencyMs);
  const modelReviews = reviews.filter((item) => item.candidateModel === model);
  const successfulReviews = modelReviews.filter((item) => item.corrected !== undefined);
  const issueCounts: Partial<Record<TranslationValidationIssue, number>> = {};
  for (const item of successful) {
    for (const issue of item.validationIssues ?? []) {
      issueCounts[issue] = (issueCounts[issue] ?? 0) + 1;
    }
  }
  const expectedTerms = successful.flatMap((item) => item.glossary);
  const matchedTerms = successful.flatMap((item) =>
    item.glossary.filter((term) =>
      normalizeGlossaryText(item.translation ?? "").includes(normalizeGlossaryText(term.target)),
    ),
  );
  return {
    requests: items.length,
    successes: successful.length,
    failures: items.length - successful.length,
    successRate: items.length > 0 ? round(successful.length / items.length, 4) : undefined,
    latencyMs: {
      mean: round(mean(latencies) ?? 0),
      p50: round(percentile(latencies, 0.5) ?? 0),
      p95: round(percentile(latencies, 0.95) ?? 0),
      max: round(Math.max(0, ...latencies)),
    },
    tokens: {
      input: successful.reduce((sum, item) => sum + (item.usage?.inputTokens ?? 0), 0),
      output: successful.reduce((sum, item) => sum + (item.usage?.outputTokens ?? 0), 0),
    },
    validationPassRate: successful.length > 0
      ? round(successful.filter((item) => (item.validationIssues?.length ?? 0) === 0).length / successful.length, 4)
      : undefined,
    validationIssueCounts: issueCounts,
    glossaryChecks: expectedTerms.length,
    glossaryExactMatchRate: expectedTerms.length > 0
      ? round(matchedTerms.length / expectedTerms.length, 4)
      : undefined,
    finalErrors: Object.fromEntries(
      [...new Set(items.map((item) => item.providerCode ?? item.error).filter(Boolean))].map((error) => [
        error,
        items.filter((item) => (item.providerCode ?? item.error) === error).length,
      ]),
    ),
    rateLimitRetries: telemetry.filter(
      (event) => event.model === model && event.type === "rate_limit_retry",
    ).length,
    review: {
      requests: modelReviews.length,
      successes: successfulReviews.length,
      corrections: successfulReviews.filter((item) => item.corrected).length,
      correctionRate: successfulReviews.length > 0
        ? round(successfulReviews.filter((item) => item.corrected).length / successfulReviews.length, 4)
        : undefined,
      latencyP50Ms: round(percentile(successfulReviews.map((item) => item.latencyMs), 0.5) ?? 0),
      latencyP95Ms: round(percentile(successfulReviews.map((item) => item.latencyMs), 0.95) ?? 0),
    },
  };
}

function probeMedia(video: string): unknown {
  const result = spawnSync(
    process.env.FFPROBE_PATH || "ffprobe",
    [
      "-v",
      "error",
      "-show_entries",
      "format=duration,size,format_name:stream=index,codec_type,codec_name,sample_rate,channels,width,height",
      "-of",
      "json",
      "--",
      video,
    ],
    { encoding: "utf8", windowsHide: true },
  );
  if (result.status !== 0) {
    throw new Error(`ffprobe failed: ${result.stderr.trim()}`);
  }
  return JSON.parse(result.stdout) as unknown;
}

function matchingGlossary(text: string): Array<{ source: string; target: string }> {
  return matchGlossaryEntries(GLOSSARY, text)
    .map(({ source, target }) => ({ source, target }));
}

function includesTerm(text: string, term: string): boolean {
  return text.toLocaleLowerCase("en").includes(term.toLocaleLowerCase("en"));
}

function normalizeGlossaryText(text: string): string {
  return text.normalize("NFKC").toLocaleLowerCase().replace(/\s+/gu, "");
}

function cleanTranscript(text: string): string {
  const cleaned = text.replace(/\s+/gu, " ").trim();
  return /^\[\s*(?:blank_audio|silence|music|pause|applause|laughter|noise)\s*\]$/iu.test(cleaned)
    ? ""
    : cleaned;
}

function speechRatio(segments: readonly BenchmarkSegment[], durationSeconds: number): number {
  const speechSeconds = segments.reduce(
    (total, segment) => total + Math.max(0, segment.endSeconds - segment.startSeconds),
    0,
  );
  return durationSeconds > 0 ? Math.min(1, speechSeconds / durationSeconds) : 0;
}

function segmentDifficulty(text: string): number {
  return text.length + matchingGlossary(text).length * 80 + normalizedNumbers(text).length * 30;
}

function round(value: number, digits = 2): number {
  const scale = 10 ** digits;
  return Math.round(value * scale) / scale;
}

function renderMarkdown(report: Record<string, unknown>): string {
  const asr = report.asr as Record<string, unknown>;
  const translation = report.translation as { models: Record<string, Record<string, unknown>> };
  const lines = [
    `# ${String((report.input as { name: string }).name)} benchmark`,
    "",
    "## Silent ingestion",
    "",
    "Audio was decoded directly from the video into a PCM pipe. No playback device was opened.",
    "",
    "## ASR",
    "",
    `- Segments: ${String(asr.segmentCount)}`,
    `- WER: ${(Number(asr.wordErrorRate) * 100).toFixed(2)}%`,
    `- Real-time factor: ${String(asr.realTimeFactor)}`,
    `- Number recall: ${asr.numberRecall === undefined ? "n/a" : `${(Number(asr.numberRecall) * 100).toFixed(2)}%`}`,
    `- Backpressure events: ${String(asr.backpressureEvents)}; dropped frames: ${String(asr.droppedFrames)}`,
    "",
    "## Translation",
    "",
    "| Model | Success | p50 ms | p95 ms | Validation | Glossary | Review corrections | 429 retries |",
    "| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |",
  ];
  for (const model of MODELS) {
    const item = translation.models[model] ?? {};
    const latency = (item.latencyMs ?? {}) as Record<string, unknown>;
    const review = (item.review ?? {}) as Record<string, unknown>;
    lines.push(
      `| ${model} | ${percent(item.successRate)} | ${String(latency.p50 ?? 0)} | ${String(latency.p95 ?? 0)} | ${percent(item.validationPassRate)} | ${percent(item.glossaryExactMatchRate)} | ${String(review.corrections ?? 0)}/${String(review.successes ?? 0)} | ${String(item.rateLimitRetries ?? 0)} |`,
    );
  }
  return `${lines.join("\n")}\n`;
}

function percent(value: unknown): string {
  return typeof value === "number" ? `${(value * 100).toFixed(1)}%` : "n/a";
}

async function parseOptions(args: string[]): Promise<CliOptions> {
  if (args[0] === "--config") {
    const configPath = args[1];
    if (!configPath || args.length !== 2) {
      throw new Error("--config requires exactly one JSON file path");
    }
    const parsed = JSON.parse(await readFile(path.resolve(configPath), "utf8")) as Partial<CliOptions>;
    return validateOptions(parsed);
  }
  const values = new Map<string, string>();
  for (let index = 0; index < args.length; index += 2) {
    const key = args[index];
    const value = args[index + 1];
    if (!key?.startsWith("--") || value === undefined) {
      throw new Error(`Invalid argument near ${key ?? "end of command"}`);
    }
    values.set(key.slice(2), value);
  }
  const video = values.get("video");
  const captions = values.get("captions");
  if (!video || !captions) {
    throw new Error(
      "Usage: benchmark:video -- --video <path> --captions <vtt> --start <seconds> --duration <seconds> --name <label> --output <directory>",
    );
  }
  return validateOptions({
    video,
    captions,
    name: values.get("name") ?? path.basename(video),
    outputDirectory: values.get("output") ?? path.join("data", "benchmarks", `run-${Date.now()}`),
    startSeconds: Number(values.get("start") ?? 0),
    durationSeconds: Number(values.get("duration") ?? 300),
    reviewCount: Number(values.get("review-count") ?? 8),
  });
}

function validateOptions(values: Partial<CliOptions>): CliOptions {
  const { video, captions } = values;
  if (!video || !captions) {
    throw new Error("Benchmark config requires video and captions paths");
  }
  const startSeconds = Number(values.startSeconds ?? 0);
  const durationSeconds = Number(values.durationSeconds ?? 300);
  const reviewCount = Number(values.reviewCount ?? 8);
  if (![startSeconds, durationSeconds, reviewCount].every(Number.isFinite)) {
    throw new Error("start, duration, and review-count must be finite numbers");
  }
  if (startSeconds < 0 || durationSeconds <= 0 || reviewCount < 0) {
    throw new Error("start must be >= 0, duration must be > 0, and review-count must be >= 0");
  }
  return {
    video: path.resolve(video),
    captions: path.resolve(captions),
    name: values.name ?? path.basename(video),
    outputDirectory: path.resolve(
      values.outputDirectory ?? path.join("data", "benchmarks", `run-${Date.now()}`),
    ),
    startSeconds,
    durationSeconds,
    reviewCount: Math.floor(reviewCount),
  };
}
