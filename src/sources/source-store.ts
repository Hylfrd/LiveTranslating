import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { z } from "zod";

import type { AudioSourceDefinition } from "../audio/types.js";

const iconSchema = z.enum(["monitor", "microphone", "headphones", "radio", "globe", "video"]);
const processSchema = z.object({
  pid: z.number().int().positive(),
  name: z.string().trim().min(1).max(256),
  executablePath: z.string().trim().min(1).max(2048).optional(),
});
const captureSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("system"),
    allSystemAudio: z.boolean(),
    processes: z.array(processSchema).max(64),
  }),
  z.object({
    kind: z.literal("microphone"),
    deviceIds: z.array(z.string().trim().min(1).max(2048)).min(1).max(64),
  }),
  z.object({
    kind: z.literal("remote"),
    token: z.string().regex(/^[a-f0-9]{16,64}$/iu),
  }),
]);
const sourceSchema = z.object({
  id: z.string().trim().regex(/^[a-z0-9][a-z0-9-]{0,127}$/u),
  name: z.string().trim().min(1).max(64),
  icon: iconSchema,
  capture: captureSchema,
  builtIn: z.boolean().optional(),
});
const sourcesSchema = z.array(sourceSchema).max(100);

export class SourceStore {
  readonly filePath: string;

  constructor(rootDirectory = process.cwd()) {
    this.filePath = path.join(rootDirectory, "data", "sources.json");
  }

  async load(): Promise<AudioSourceDefinition[]> {
    try {
      const raw = await readFile(this.filePath, "utf8");
      return sourcesSchema.parse(JSON.parse(raw)) as AudioSourceDefinition[];
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
  }

  async save(sources: readonly AudioSourceDefinition[]): Promise<void> {
    await mkdir(path.dirname(this.filePath), { recursive: true });
    const validated = sourcesSchema.parse(sources);
    await writeFile(this.filePath, `${JSON.stringify(validated, null, 2)}\n`, "utf8");
  }
}
