export function sanitizeBenchmarkValue(value: unknown, depth = 0): unknown {
  if (depth > 12) return "[MAX_DEPTH]";
  if (value === null || typeof value === "boolean" || typeof value === "number") return value;
  if (typeof value === "string") return redactBenchmarkText(value);
  if (typeof value === "bigint") return value.toString();
  if (Array.isArray(value)) return value.map((item) => sanitizeBenchmarkValue(item, depth + 1));
  if (typeof value === "object") {
    const output: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) {
      output[key] = isSensitiveKey(key)
        ? "[REDACTED]"
        : sanitizeBenchmarkValue(item, depth + 1);
    }
    return output;
  }
  return redactBenchmarkText(String(value));
}

export function redactBenchmarkText(value: string): string {
  return value
    .replace(/\bsk-[A-Za-z0-9_-]{8,}\b/gu, "[REDACTED]")
    .replace(/\bBearer\s+[A-Za-z0-9._~+\/-]+=*\b/giu, "Bearer [REDACTED]")
    .replace(/([?&](?:signature|secretid|token)=)[^&\s]+/giu, "$1[REDACTED]");
}

function isSensitiveKey(key: string): boolean {
  return /^(?:authorization|api[-_]?key|secret|secretid|secretkey|password|signature|access[-_]?token|refresh[-_]?token|token)$/iu.test(key);
}
