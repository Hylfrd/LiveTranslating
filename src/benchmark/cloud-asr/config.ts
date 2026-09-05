import { readFile } from "node:fs/promises";
import path from "node:path";

import { z } from "zod";

import {
  CLOUD_ASR_PROVIDER_IDS,
  type CloudAsrBenchmarkConfig,
  type CloudAsrProviderId,
} from "./types.js";

const configSchema = z.object({
  name: z.string().trim().min(1).max(128),
  provider: z.enum(CLOUD_ASR_PROVIDER_IDS),
  input: z.string().trim().min(1),
  reference: z.string().trim().min(1).optional(),
  referenceText: z.string().trim().min(1).optional(),
  outputDirectory: z.string().trim().min(1),
  startSeconds: z.number().finite().min(0).default(0),
  durationSeconds: z.number().finite().positive().max(4 * 60 * 60),
  frameMs: z.number().int().min(20).max(200).default(100),
  language: z.string().trim().min(2).max(32).optional(),
  providerOptions: z.record(z.string(), z.unknown()).default({}),
}).refine((value) => Boolean(value.reference || value.referenceText), {
  message: "Either reference or referenceText is required",
});

export async function loadBenchmarkConfig(
  filePath: string,
  providerOverride?: CloudAsrProviderId,
): Promise<CloudAsrBenchmarkConfig> {
  const absolutePath = path.resolve(filePath);
  const parsedJson: unknown = JSON.parse(await readFile(absolutePath, "utf8"));
  const parsed = configSchema.parse(parsedJson);
  const baseDirectory = path.dirname(absolutePath);
  const provider = providerOverride ?? parsed.provider;
  return {
    name: parsed.name,
    provider,
    input: resolveInput(baseDirectory, parsed.input),
    ...(parsed.reference ? { reference: path.resolve(baseDirectory, parsed.reference) } : {}),
    ...(parsed.referenceText ? { referenceText: parsed.referenceText } : {}),
    outputDirectory: path.resolve(baseDirectory, parsed.outputDirectory, provider),
    startSeconds: parsed.startSeconds,
    durationSeconds: parsed.durationSeconds,
    frameMs: parsed.frameMs,
    ...(parsed.language ? { language: parsed.language } : {}),
    providerOptions: parsed.providerOptions,
  };
}

function resolveInput(baseDirectory: string, input: string): string {
  return input.startsWith("synthetic:") ? input : path.resolve(baseDirectory, input);
}
