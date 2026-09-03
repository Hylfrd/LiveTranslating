import type { TuiLogLevel, TuiSourcePhase } from "./controller.js";

export const tuiColors = {
  accent: "cyan",
  dim: "gray",
  error: "red",
  ok: "green",
  text: "white",
  warning: "yellow",
} as const;

export function phaseColor(
  phase: TuiSourcePhase,
): (typeof tuiColors)[keyof typeof tuiColors] {
  switch (phase) {
    case "listening":
      return tuiColors.ok;
    case "starting":
      return tuiColors.warning;
    case "error":
      return tuiColors.error;
    case "disabled":
    case "paused":
      return tuiColors.dim;
  }
}

export function logColor(
  level: TuiLogLevel,
): (typeof tuiColors)[keyof typeof tuiColors] {
  switch (level) {
    case "error":
      return tuiColors.error;
    case "warn":
      return tuiColors.warning;
    case "debug":
      return tuiColors.dim;
    case "info":
      return tuiColors.text;
  }
}

