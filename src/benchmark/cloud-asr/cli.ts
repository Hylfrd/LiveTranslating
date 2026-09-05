import { loadBenchmarkConfig } from "./config.js";
import { createCloudAsrAdapter } from "./providers/index.js";
import { runCloudAsrBenchmark } from "./runner.js";
import {
  CLOUD_ASR_PROVIDER_IDS,
  type CloudAsrProviderId,
} from "./types.js";

const args = process.argv.slice(2);
if (args.includes("--list-providers")) {
  console.log(CLOUD_ASR_PROVIDER_IDS.join("\n"));
  process.exit(0);
}
const configPath = optionValue(args, "--config");
if (!configPath) {
  throw new Error("Usage: benchmark:cloud-asr -- --config <file.json> [--provider <id>] [--preflight]");
}
const providerValue = optionValue(args, "--provider");
const providerOverride = providerValue ? parseProvider(providerValue) : undefined;
const config = await loadBenchmarkConfig(configPath, providerOverride);
const adapter = createCloudAsrAdapter(config.provider);
const frameWarning = adapter.recommendedFrameMs.includes(config.frameMs)
  ? undefined
  : `Configured frameMs=${config.frameMs}; ${adapter.id} official examples recommend ${adapter.recommendedFrameMs.join(" or ")} ms`;
const missing = adapter.requiredEnvironment.filter((name) => !process.env[name]?.trim());
if (missing.length > 0) {
  throw new Error(`Missing environment variables for ${adapter.id}: ${missing.join(", ")}`);
}
if (args.includes("--preflight")) {
  console.log(JSON.stringify({
    ok: true,
    provider: adapter.id,
    frameMs: config.frameMs,
    recommendedFrameMs: adapter.recommendedFrameMs,
    ...(frameWarning ? { warning: frameWarning } : {}),
    requiredEnvironment: adapter.requiredEnvironment,
    outputDirectory: config.outputDirectory,
  }, null, 2));
  process.exit(0);
}
if (frameWarning) console.warn(frameWarning);
const report = await runCloudAsrBenchmark(config, adapter);
console.log(JSON.stringify({
  outputDirectory: config.outputDirectory,
  provider: report.provider,
  timing: report.timing,
  events: report.events,
  accuracy: report.accuracy,
}, null, 2));

function optionValue(values: readonly string[], name: string): string | undefined {
  const index = values.indexOf(name);
  return index >= 0 ? values[index + 1] : undefined;
}

function parseProvider(value: string): CloudAsrProviderId {
  if ((CLOUD_ASR_PROVIDER_IDS as readonly string[]).includes(value)) {
    return value as CloudAsrProviderId;
  }
  throw new Error(`Unknown provider ${value}; expected ${CLOUD_ASR_PROVIDER_IDS.join(", ")}`);
}
