export interface CaptionCue {
  readonly startSeconds: number;
  readonly endSeconds: number;
  readonly text: string;
}

export function parseVtt(input: string): CaptionCue[] {
  const normalized = input.replace(/^\uFEFF/u, "").replace(/\r\n?/gu, "\n");
  const blocks = normalized.split(/\n{2,}/u);
  const cues: CaptionCue[] = [];

  for (const block of blocks) {
    const lines = block.split("\n").map((line) => line.trim());
    const timingIndex = lines.findIndex((line) => line.includes("-->"));
    if (timingIndex < 0) {
      continue;
    }
    const timing = lines[timingIndex]?.match(
      /^(\d{2,}):(\d{2}):(\d{2})[.,](\d{3})\s*-->\s*(\d{2,}):(\d{2}):(\d{2})[.,](\d{3})/u,
    );
    if (!timing) {
      continue;
    }
    const text = decodeEntities(
      lines
        .slice(timingIndex + 1)
        .join(" ")
        .replace(/<[^>]+>/gu, "")
        .replace(/\s+/gu, " ")
        .trim(),
    );
    if (!text) {
      continue;
    }
    cues.push({
      startSeconds: timestampPartsToSeconds(timing.slice(1, 5)),
      endSeconds: timestampPartsToSeconds(timing.slice(5, 9)),
      text,
    });
  }

  return cues;
}

function timestampPartsToSeconds(parts: string[]): number {
  const [hours = "0", minutes = "0", seconds = "0", millis = "0"] = parts;
  return Number(hours) * 3600 + Number(minutes) * 60 + Number(seconds) + Number(millis) / 1000;
}

function decodeEntities(value: string): string {
  return value
    .replaceAll("&amp;", "&")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&quot;", '"')
    .replaceAll("&#39;", "'")
    .replaceAll("&nbsp;", " ");
}
