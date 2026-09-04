import { useEffect, useMemo, useRef, useState } from "react";
import {
  AlertCircle,
  ArrowLeftRight,
  CircleStop,
  ExternalLink,
  FileAudio,
  Languages,
  Mic,
  MonitorSpeaker,
  Play,
  Radio,
  Settings,
  ShieldCheck,
  Sparkles,
  X,
} from "lucide-react";

import type {
  TuiAudioDevice,
  TuiLanguage,
  TuiSnapshot,
  TuiSourceId,
  TuiSourcePhase,
  TuiSourceState,
  TuiSubtitleEntry,
  TuiSubtitleParagraph,
} from "../../tui/controller.js";
import { readSourcePreference, writeSourcePreference } from "./source-preference.js";
import { LevelMeter, Toggle } from "./ui.js";
import { useDesktopBridge } from "./use-desktop-bridge.js";

type AppPage = TuiSourceId | "settings";

interface ParagraphTaggedEntry extends TuiSubtitleEntry {
  readonly paragraphId?: string;
  readonly startsParagraph?: boolean;
  readonly paragraphBreakBefore?: boolean;
}

interface TranscriptParagraph {
  readonly id: string;
  readonly entries: readonly TuiSubtitleEntry[];
}

const PHASE_LABELS: Record<TuiSourcePhase, string> = {
  disabled: "未启用",
  starting: "正在连接",
  listening: "正在收听",
  paused: "已暂停",
  error: "异常",
};

const SOURCE_LABELS: Record<TuiSourceId, string> = {
  system: "电脑声音",
  microphone: "麦克风",
};

const MODEL_LABELS = {
  "deepseek-v4-flash": "DeepSeek V4 Flash",
  "hy-mt2-plus": "Hunyuan MT2 Plus",
  "hy-mt2-pro": "Hunyuan MT2 Pro",
} as const;

function languageLabel(languages: readonly TuiLanguage[], code: string): string {
  const raw = languages.find((item) => item.code === code)?.label ?? code.toUpperCase();
  const localized: Record<string, string> = {
    "Auto detect": "自动检测",
    English: "英语",
    Chinese: "中文",
    "Simplified Chinese": "简体中文",
    Japanese: "日语",
    Korean: "韩语",
    French: "法语",
    German: "德语",
    Spanish: "西班牙语",
    Russian: "俄语",
    Portuguese: "葡萄牙语",
    Italian: "意大利语",
    Arabic: "阿拉伯语",
  };
  return localized[raw] ?? raw;
}

function joinSubtitleParts(parts: readonly string[], language: string): string {
  return parts.join(/^(?:zh|ja|ko)(?:-|$)/iu.test(language) ? "" : " ");
}

function clockSeconds(value: string): number | undefined {
  const parts = value.split(":").map(Number);
  if (parts.length !== 3 || parts.some((part) => !Number.isFinite(part))) {
    return undefined;
  }
  const [hours = 0, minutes = 0, seconds = 0] = parts;
  return hours * 3600 + minutes * 60 + seconds;
}

function groupIntoParagraphs(entries: readonly TuiSubtitleEntry[]): TranscriptParagraph[] {
  const paragraphs: Array<{ id: string; entries: TuiSubtitleEntry[]; explicitId?: string }> = [];

  for (const entry of entries) {
    const tagged = entry as ParagraphTaggedEntry;
    const current = paragraphs.at(-1);
    const previous = current?.entries.at(-1);
    const explicitChanged = Boolean(
      tagged.paragraphId && current?.explicitId && tagged.paragraphId !== current.explicitId,
    );
    const gap = previous
      ? (clockSeconds(entry.timestamp) ?? 0) - (clockSeconds(previous.timestamp) ?? 0)
      : 0;
    const fallbackBreak = !tagged.paragraphId && Boolean(current && (
      current.entries.length >= 4 || gap >= 14
    ));
    const startsNew = !current
      || tagged.startsParagraph
      || tagged.paragraphBreakBefore
      || explicitChanged
      || fallbackBreak;

    if (startsNew) {
      paragraphs.push({
        id: tagged.paragraphId ?? entry.id,
        entries: [entry],
        ...(tagged.paragraphId ? { explicitId: tagged.paragraphId } : {}),
      });
    } else {
      current.entries.push(entry);
      if (!current.explicitId && tagged.paragraphId) {
        current.explicitId = tagged.paragraphId;
      }
    }
  }

  return paragraphs;
}

function SelectField({
  label,
  value,
  options,
  disabled,
  onChange,
}: {
  readonly label: string;
  readonly value: string;
  readonly options: ReadonlyArray<{ readonly value: string; readonly label: string }>;
  readonly disabled: boolean;
  readonly onChange: (value: string) => void;
}) {
  return (
    <label className="select-field">
      <span>{label}</span>
      <select value={value} disabled={disabled} onChange={(event) => onChange(event.target.value)}>
        {options.map((option) => (
          <option value={option.value} key={option.value}>{option.label}</option>
        ))}
      </select>
    </label>
  );
}

function ToastStack({
  bridgeError,
  sourceError,
  onDismissBridge,
  onDismissSource,
}: {
  readonly bridgeError: string | undefined;
  readonly sourceError: string | undefined;
  readonly onDismissBridge: () => void;
  readonly onDismissSource: () => void;
}) {
  if (!bridgeError && !sourceError) {
    return null;
  }
  return (
    <div className="toast-stack">
      {bridgeError ? (
        <Toast message={bridgeError} onDismiss={onDismissBridge} />
      ) : null}
      {sourceError ? (
        <Toast message={sourceError} onDismiss={onDismissSource} />
      ) : null}
    </div>
  );
}

function Toast({ message, onDismiss }: { readonly message: string; readonly onDismiss: () => void }) {
  const [leaving, setLeaving] = useState(false);
  const dismissRef = useRef(onDismiss);
  useEffect(() => {
    dismissRef.current = onDismiss;
  }, [onDismiss]);
  useEffect(() => {
    setLeaving(false);
    const leaveTimer = window.setTimeout(() => setLeaving(true), 5200);
    const dismissTimer = window.setTimeout(() => dismissRef.current(), 5600);
    return () => {
      window.clearTimeout(leaveTimer);
      window.clearTimeout(dismissTimer);
    };
  }, [message]);
  return (
    <div className={`toast${leaving ? " is-leaving" : ""}`} role="alert">
      <AlertCircle aria-hidden="true" />
      <span>{message}</span>
      <button type="button" aria-label="关闭提示" title="关闭提示" onClick={onDismiss}>
        <X aria-hidden="true" />
      </button>
    </div>
  );
}

function Sidebar({
  page,
  snapshot,
  pending,
  connected,
  onNavigate,
  onOpenOverlay,
  onToggleRunning,
}: {
  readonly page: AppPage;
  readonly snapshot: TuiSnapshot;
  readonly pending: boolean;
  readonly connected: boolean;
  readonly onNavigate: (page: AppPage) => void;
  readonly onOpenOverlay: () => void;
  readonly onToggleRunning: () => void;
}) {
  return (
    <aside className="sidebar">
      <div className="sidebar__brand">
        <span><Languages aria-hidden="true" /></span>
        <strong>同传席</strong>
      </div>

      <nav className="sidebar__nav" aria-label="主导航">
        {([
          ["system", "电脑声音", MonitorSpeaker],
          ["microphone", "麦克风", Mic],
          ["settings", "设置", Settings],
        ] as const).map(([id, label, Icon]) => {
          const source = id === "settings" ? undefined : snapshot.sources[id];
          return (
            <button
              key={id}
              type="button"
              className={page === id ? "is-active" : undefined}
              aria-current={page === id ? "page" : undefined}
              onClick={() => onNavigate(id)}
            >
              <Icon aria-hidden="true" />
              <span>{label}</span>
              {source ? (
                <i className={`nav-state nav-state--${source.phase}`} aria-label={PHASE_LABELS[source.phase]} />
              ) : null}
            </button>
          );
        })}
      </nav>

      <div className="sidebar__actions">
        <button className="overlay-command" type="button" onClick={onOpenOverlay}>
          <ExternalLink aria-hidden="true" />
          <span>字幕小窗</span>
        </button>
        <button
          className={`run-command${snapshot.running ? " is-stopping" : ""}`}
          type="button"
          disabled={pending || !connected}
          onClick={onToggleRunning}
        >
          {snapshot.running ? <CircleStop aria-hidden="true" /> : <Play aria-hidden="true" />}
          <span>{snapshot.transitioning ? "正在处理" : snapshot.running ? "停止收听" : "开始收听"}</span>
          {snapshot.recording ? <i>REC</i> : null}
        </button>
      </div>
    </aside>
  );
}

function SourceHeader({
  source,
  devices,
  pending,
  onToggle,
  onSelectDevice,
}: {
  readonly source: TuiSourceState;
  readonly devices: readonly TuiAudioDevice[];
  readonly pending: boolean;
  readonly onToggle: () => void;
  readonly onSelectDevice: (deviceId: string) => void;
}) {
  const Icon = source.id === "system" ? MonitorSpeaker : Mic;
  const listening = source.enabled && source.phase === "listening";
  return (
    <header className="source-header">
      <div className="source-header__identity">
        <span className={`source-header__icon source-header__icon--${source.phase}`}>
          <Icon aria-hidden="true" />
        </span>
        <div>
          <h1>{SOURCE_LABELS[source.id]}</h1>
          <span className={`phase phase--${source.phase}`}>{PHASE_LABELS[source.phase]}</span>
        </div>
      </div>

      <div className="source-header__device">
        {source.id === "microphone" ? (
          <label>
            <span>输入设备</span>
            <select
              value={source.deviceId ?? ""}
              disabled={pending || devices.length === 0}
              onChange={(event) => onSelectDevice(event.target.value)}
            >
              {devices.length === 0 ? <option value="">没有检测到麦克风</option> : null}
              {devices.map((device) => (
                <option value={device.id} key={device.id}>
                  {device.label}{device.isDefault ? "（默认）" : ""}
                </option>
              ))}
            </select>
          </label>
        ) : (
          <div className="output-device">
            <span>播放设备</span>
            <strong title={source.deviceLabel}>{source.deviceLabel ?? "Windows 默认播放设备"}</strong>
          </div>
        )}
      </div>

      <div className="source-header__meter">
        <LevelMeter level={source.level} active={listening} />
      </div>
      <dl className="source-header__stats">
        <div><dt>延迟</dt><dd>{source.latencyMs === undefined ? "--" : `${Math.round(source.latencyMs)} ms`}</dd></div>
        <div><dt>丢帧</dt><dd className={source.droppedFrames ? "is-warning" : undefined}>{source.droppedFrames ?? 0}</dd></div>
      </dl>
      <Toggle
        checked={source.enabled}
        disabled={pending}
        label={`${source.enabled ? "关闭" : "开启"}${SOURCE_LABELS[source.id]}`}
        onChange={onToggle}
      />
    </header>
  );
}

function TranscriptReader({
  sourceId,
  entries,
  backendParagraphs,
  running,
  sourceLanguage,
  targetLanguage,
}: {
  readonly sourceId: TuiSourceId;
  readonly entries: readonly TuiSubtitleEntry[];
  readonly backendParagraphs: readonly TuiSubtitleParagraph[] | undefined;
  readonly running: boolean;
  readonly sourceLanguage: string;
  readonly targetLanguage: string;
}) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const stickToBottom = useRef(true);
  const sourceEntries = useMemo(
    () => entries.filter((entry) => entry.sourceId === sourceId).slice(-160),
    [entries, sourceId],
  );
  const paragraphs = useMemo<TranscriptParagraph[]>(() => {
    if (backendParagraphs) {
      return backendParagraphs.map((paragraph) => ({
        id: paragraph.id,
        entries: paragraph.sentences,
      }));
    }
    return groupIntoParagraphs(sourceEntries);
  }, [backendParagraphs, sourceEntries]);
  const latestTranslation = sourceEntries.at(-1);
  const latestAnnouncedTranslation = latestTranslation
    ? (latestTranslation.revisedTranslation ?? latestTranslation.translation)
    : "";

  useEffect(() => {
    if (stickToBottom.current && scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [sourceEntries.length]);

  const handleScroll = () => {
    const element = scrollRef.current;
    if (element) {
      stickToBottom.current = element.scrollHeight - element.scrollTop - element.clientHeight < 72;
    }
  };

  return (
    <div className="transcript-reader" ref={scrollRef} onScroll={handleScroll} tabIndex={0}>
      {paragraphs.length === 0 ? (
        <div className="transcript-empty">
          <Radio aria-hidden="true" />
          <strong>{running ? "等待下一句话" : "准备开始同传"}</strong>
          <span>{running ? "检测到语音后，译文会出现在这里。" : "开启当前来源并开始收听。"}</span>
        </div>
      ) : (
        <div className="paragraph-flow">
          {paragraphs.map((paragraph) => (
            <article className="transcript-paragraph" key={paragraph.id}>
              <div className="paragraph-meta">
                <time>{paragraph.entries[0]?.timestamp}</time>
                {paragraph.entries.some(
                  (entry) => entry.revisedTranslation && entry.revisedTranslation !== entry.translation,
                ) ? <span><ShieldCheck aria-hidden="true" />已复核</span> : null}
                {paragraph.entries.some((entry) => !entry.isFinal) ? <span>识别中</span> : null}
              </div>
              <p className="paragraph-source" lang={sourceLanguage === "auto" ? undefined : sourceLanguage}>
                {joinSubtitleParts(
                  paragraph.entries.map((entry) => entry.sourceText || "正在识别…"),
                  sourceLanguage,
                )}
              </p>
              <p className="paragraph-translation" lang={targetLanguage}>
                {joinSubtitleParts(
                  paragraph.entries.map(
                    (entry) => (entry.revisedTranslation ?? entry.translation) || "正在翻译…",
                  ),
                  targetLanguage,
                )}
              </p>
            </article>
          ))}
        </div>
      )}
      <span className="sr-only" aria-live="polite" aria-atomic="true">
        {latestAnnouncedTranslation}
      </span>
    </div>
  );
}

function SourceView({
  sourceId,
  snapshot,
  pending,
  onToggleSource,
  onSelectDevice,
}: {
  readonly sourceId: TuiSourceId;
  readonly snapshot: TuiSnapshot;
  readonly pending: boolean;
  readonly onToggleSource: () => void;
  readonly onSelectDevice: (deviceId: string) => void;
}) {
  return (
    <section className="source-view">
      <SourceHeader
        source={snapshot.sources[sourceId]}
        devices={snapshot.microphoneDevices}
        pending={pending}
        onToggle={onToggleSource}
        onSelectDevice={onSelectDevice}
      />
      <TranscriptReader
        sourceId={sourceId}
        entries={snapshot.subtitles}
        backendParagraphs={snapshot.paragraphs?.[sourceId]}
        running={snapshot.running}
        sourceLanguage={snapshot.sourceLanguage}
        targetLanguage={snapshot.targetLanguage}
      />
    </section>
  );
}

function SettingsView({
  snapshot,
  pending,
  onAction,
}: {
  readonly snapshot: TuiSnapshot;
  readonly pending: boolean;
  readonly onAction: (
    name: "set-source-language" | "set-target-language" | "set-model" | "set-reviewer" | "set-recording",
    payload: { language: string } | { model: TuiSnapshot["model"] } | { enabled: boolean },
  ) => void;
}) {
  const unhealthy = Object.values(snapshot.sources).some(
    (source) => source.enabled && (source.phase === "error" || Boolean(source.droppedFrames)),
  );
  return (
    <section className="settings-view">
      <div className="settings-sheet">
        <section className="settings-section">
          <h1>翻译</h1>
          <div className="translation-fields">
            <SelectField
              label="源语言"
              value={snapshot.sourceLanguage}
              options={snapshot.sourceLanguages.map((language) => ({
                value: language.code,
                label: languageLabel(snapshot.sourceLanguages, language.code),
              }))}
              disabled={pending}
              onChange={(language) => onAction("set-source-language", { language })}
            />
            <ArrowLeftRight aria-label="翻译为" />
            <SelectField
              label="译入语言"
              value={snapshot.targetLanguage}
              options={snapshot.targetLanguages.map((language) => ({
                value: language.code,
                label: languageLabel(snapshot.targetLanguages, language.code),
              }))}
              disabled={pending}
              onChange={(language) => onAction("set-target-language", { language })}
            />
            <SelectField
              label="主模型"
              value={snapshot.model}
              options={Object.entries(MODEL_LABELS).map(([value, label]) => ({ value, label }))}
              disabled={pending}
              onChange={(model) => onAction("set-model", { model: model as TuiSnapshot["model"] })}
            />
          </div>
        </section>

        <section className="settings-section settings-row">
          <span className="settings-row__icon"><Sparkles aria-hidden="true" /></span>
          <div>
            <h2>DeepSeek 延迟术语复核</h2>
            <p>{snapshot.reviewerEnabled
              ? snapshot.reviewQueueSize
                ? `${snapshot.reviewQueueSize} 条等待复核。根据最近上下文尝试核对专业词义，证据不足时保留初译。`
                : "队列空闲。根据最近上下文尝试核对专业词义，证据不足时保留初译。"
              : "已关闭。初译结果不会经过第二模型复核。"}</p>
          </div>
          <Toggle
            checked={snapshot.reviewerEnabled}
            disabled={pending}
            label={`${snapshot.reviewerEnabled ? "关闭" : "开启"} DeepSeek 延迟术语复核`}
            onChange={() => onAction("set-reviewer", { enabled: !snapshot.reviewerEnabled })}
          />
        </section>

        <section className="settings-section settings-row">
          <span className={`settings-row__icon${snapshot.recording ? " is-recording" : ""}`}>
            <FileAudio aria-hidden="true" />
          </span>
          <div>
            <h2>保存分轨录音</h2>
            <p>{snapshot.recording ? "正在写入音频与字幕" : "已关闭"}</p>
          </div>
          <Toggle
            checked={snapshot.recording}
            disabled={pending}
            label={`${snapshot.recording ? "停止" : "开始"}保存录音`}
            onChange={() => onAction("set-recording", { enabled: !snapshot.recording })}
          />
        </section>

        <section className="settings-section">
          <div className="settings-heading">
            <h2>处理健康</h2>
            <span className={unhealthy ? "is-warning" : "is-healthy"}>
              {unhealthy ? <AlertCircle aria-hidden="true" /> : <ShieldCheck aria-hidden="true" />}
              {unhealthy ? "需要注意" : "链路正常"}
            </span>
          </div>
          <div className="health-table">
            {(Object.keys(snapshot.sources) as TuiSourceId[]).map((sourceId) => {
              const source = snapshot.sources[sourceId];
              return (
                <div key={sourceId}>
                  <strong>{SOURCE_LABELS[sourceId]}</strong>
                  <span className={`phase phase--${source.phase}`}>{PHASE_LABELS[source.phase]}</span>
                  <span>{source.latencyMs === undefined ? "--" : `${Math.round(source.latencyMs)} ms`}</span>
                  <span className={source.droppedFrames ? "is-warning" : undefined}>
                    {source.droppedFrames ?? 0} 丢帧
                  </span>
                </div>
              );
            })}
          </div>
        </section>

        <section className="settings-section log-section">
          <div className="settings-heading"><h2>运行日志</h2></div>
          <div className="log-list" tabIndex={0}>
            {snapshot.logs.length === 0 ? (
              <p className="settings-empty">暂无日志</p>
            ) : snapshot.logs.slice(-80).reverse().map((entry) => (
              <div className={`log-row log-row--${entry.level}`} key={entry.id}>
                <time>{entry.timestamp}</time>
                <span>{entry.source ?? entry.level.toUpperCase()}</span>
                <p>{entry.message}</p>
              </div>
            ))}
          </div>
        </section>
      </div>
    </section>
  );
}

function LoadingShell() {
  return (
    <div className="loading-shell" aria-label="正在连接后端" aria-busy="true">
      <div className="loading-shell__nav" />
      <div className="loading-shell__content" />
    </div>
  );
}

export function App() {
  const {
    snapshot,
    loading,
    pendingAction,
    error,
    connected,
    invoke,
    controlWindow,
    clearError,
    reconnect,
  } = useDesktopBridge();
  const [page, setPage] = useState<AppPage>(() => readSourcePreference());
  const [dismissedSourceError, setDismissedSourceError] = useState<string>();
  const pending = Boolean(pendingAction || snapshot?.transitioning);

  const navigate = (nextPage: AppPage) => {
    setPage(nextPage);
    if (nextPage !== "settings") {
      writeSourcePreference(nextPage);
    }
  };

  useEffect(() => {
    const handleKeyboard = (event: KeyboardEvent) => {
      const element = event.target as HTMLElement | null;
      if (element?.matches("input, textarea, select, [contenteditable='true']") || event.repeat) {
        return;
      }
      if (event.ctrlKey && event.shiftKey && event.key.toLowerCase() === "s") {
        event.preventDefault();
        void controlWindow("open-overlay");
      } else if (!event.ctrlKey && !event.metaKey && !event.altKey && event.key.toLowerCase() === "r") {
        void invoke("set-recording", { enabled: !snapshot?.recording });
      } else if (!event.ctrlKey && !event.metaKey && !event.altKey && event.key.toLowerCase() === "v") {
        void invoke("set-reviewer", { enabled: !snapshot?.reviewerEnabled });
      }
    };
    window.addEventListener("keydown", handleKeyboard);
    return () => window.removeEventListener("keydown", handleKeyboard);
  }, [controlWindow, invoke, snapshot?.recording, snapshot?.reviewerEnabled]);

  if (loading && !snapshot) {
    return <LoadingShell />;
  }

  if (!snapshot) {
    return (
      <main className="fatal-state">
        <Languages aria-hidden="true" />
        <h1>同传席暂时无法连接</h1>
        <p>{error ?? "没有收到后端状态。"}</p>
        <button className="text-button" type="button" onClick={reconnect}>重新连接</button>
      </main>
    );
  }

  const activeSource = page === "settings" ? undefined : snapshot.sources[page];
  const sourceErrorKey = activeSource?.error ? `${activeSource.id}:${activeSource.error}` : undefined;
  const sourceError = activeSource?.error && sourceErrorKey !== dismissedSourceError
    ? activeSource.error
    : undefined;

  return (
    <main className="desktop-app">
      <Sidebar
        page={page}
        snapshot={snapshot}
        pending={pending}
        connected={connected}
        onNavigate={navigate}
        onOpenOverlay={() => void controlWindow("open-overlay")}
        onToggleRunning={() => void invoke("set-running", { enabled: !snapshot.running })}
      />
      <div className="content-surface">
        {page === "settings" ? (
          <SettingsView
            snapshot={snapshot}
            pending={pending}
            onAction={(name, payload) => void invoke(name, payload)}
          />
        ) : (
          <SourceView
            sourceId={page}
            snapshot={snapshot}
            pending={pending}
            onToggleSource={() => void invoke("set-source-enabled", {
              sourceId: page,
              enabled: !snapshot.sources[page].enabled,
            })}
            onSelectDevice={(deviceId) => void invoke("set-microphone", { deviceId })}
          />
        )}
      </div>
      <ToastStack
        bridgeError={error}
        sourceError={sourceError}
        onDismissBridge={clearError}
        onDismissSource={() => setDismissedSourceError(sourceErrorKey)}
      />
    </main>
  );
}
