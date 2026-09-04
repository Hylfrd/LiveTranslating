import { useEffect, useRef, useState } from "react";
import { AlertCircle, Expand, Minus, Radio, X } from "lucide-react";

import type { TuiSourceId, TuiSubtitleEntry } from "../../tui/controller.js";
import {
  readSourcePreference,
  SOURCE_PREFERENCE_EVENT,
  SOURCE_PREFERENCE_KEY,
} from "./source-preference.js";
import { IconButton } from "./ui.js";
import { useDesktopBridge } from "./use-desktop-bridge.js";

function SubtitleLine({
  entry,
  latest,
}: {
  readonly entry: TuiSubtitleEntry;
  readonly latest: boolean;
}) {
  return (
    <article className={`overlay-line${latest ? " overlay-line--latest" : ""}`}>
      <div className="overlay-line__meta">
        <time>{entry.timestamp}</time>
        {entry.revisedTranslation && entry.revisedTranslation !== entry.translation ? (
          <span>已复核</span>
        ) : null}
      </div>
      <p lang="en">{entry.sourceText}</p>
      <strong lang="zh-CN">{(entry.revisedTranslation ?? entry.translation) || "正在翻译…"}</strong>
    </article>
  );
}

export function OverlayApp() {
  const { snapshot, loading, error, controlWindow, clearError } = useDesktopBridge();
  const [sourceId, setSourceId] = useState<TuiSourceId>(() => readSourcePreference());
  const subtitleScrollRef = useRef<HTMLElement>(null);

  useEffect(() => {
    const handleStorage = (event: StorageEvent) => {
      if (event.key === SOURCE_PREFERENCE_KEY) {
        setSourceId(event.newValue === "microphone" ? "microphone" : "system");
      }
    };
    const handleLocalChange = (event: Event) => {
      const customEvent = event as CustomEvent<TuiSourceId>;
      setSourceId(customEvent.detail === "microphone" ? "microphone" : "system");
    };
    window.addEventListener("storage", handleStorage);
    window.addEventListener(SOURCE_PREFERENCE_EVENT, handleLocalChange);
    return () => {
      window.removeEventListener("storage", handleStorage);
      window.removeEventListener(SOURCE_PREFERENCE_EVENT, handleLocalChange);
    };
  }, []);

  const entries = snapshot?.subtitles
    .filter((entry) => entry.sourceId === sourceId)
    .slice(-3) ?? [];
  const latestEntry = entries.at(-1);
  const latestTranslation = latestEntry
    ? (latestEntry.revisedTranslation ?? latestEntry.translation)
    : "";

  useEffect(() => {
    const element = subtitleScrollRef.current;
    if (element) {
      element.scrollTop = element.scrollHeight;
    }
  }, [entries.length, latestTranslation]);

  return (
    <main className="overlay-app">
      <header className="overlay-titlebar">
        <IconButton
          className="overlay-window-button overlay-window-button--expand"
          icon={Expand}
          size="small"
          label="放大并打开主窗口"
          onClick={() => void controlWindow("expand-overlay")}
        />
        <div className="overlay-titlebar__spacer" />
        <IconButton
          className="overlay-window-button"
          icon={Minus}
          size="small"
          label="最小化"
          onClick={() => void controlWindow("minimize")}
        />
        <IconButton
          className="overlay-window-button overlay-window-button--close"
          icon={X}
          size="small"
          label="关闭字幕小窗"
          onClick={() => void controlWindow("close")}
        />
      </header>

      {error ? (
        <div className="overlay-toast" role="alert">
          <AlertCircle aria-hidden="true" />
          <span>{error}</span>
          <button type="button" onClick={clearError} aria-label="关闭提示" title="关闭提示">
            <X aria-hidden="true" />
          </button>
        </div>
      ) : null}

      <section className="overlay-subtitles" aria-busy={loading} ref={subtitleScrollRef}>
        <div className="overlay-subtitles__stack">
          {entries.length === 0 ? (
            <div className="overlay-empty">
              <Radio aria-hidden="true" />
              <strong>{loading ? "正在连接" : snapshot?.running ? "等待下一句话" : "等待开始同传"}</strong>
            </div>
          ) : entries.map((entry, index) => (
            <SubtitleLine key={entry.id} entry={entry} latest={index === entries.length - 1} />
          ))}
        </div>
        <span className="sr-only" aria-live="polite" aria-atomic="true">{latestTranslation}</span>
      </section>
    </main>
  );
}
