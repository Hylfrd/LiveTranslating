import type { TuiSourceId } from "../../tui/controller.js";

export const SOURCE_PREFERENCE_KEY = "live-translating:current-source";
export const SOURCE_PREFERENCE_EVENT = "live-translating:source-change";

export function readSourcePreference(): TuiSourceId {
  try {
    return window.localStorage.getItem(SOURCE_PREFERENCE_KEY) || "system";
  } catch {
    return "system";
  }
}

export function writeSourcePreference(sourceId: TuiSourceId): void {
  try {
    window.localStorage.setItem(SOURCE_PREFERENCE_KEY, sourceId);
  } catch {
    // The active view still changes when storage is unavailable.
  }
  window.dispatchEvent(new CustomEvent<TuiSourceId>(SOURCE_PREFERENCE_EVENT, {
    detail: sourceId,
  }));
}
