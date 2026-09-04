import { useEffect, useMemo, useRef, useState } from "react";
import {
  Activity,
  AlertCircle,
  CheckCircle2,
  ChevronRight,
  Download,
  ExternalLink,
  FileAudio,
  FileText,
  FolderArchive,
  Layers3,
  LoaderCircle,
  Mic,
  MonitorSpeaker,
  PanelRightClose,
  PanelRightOpen,
  Pause,
  Play,
  Radio,
  RefreshCw,
  Settings,
  ShieldCheck,
  Sparkles,
  Square,
  X,
} from "lucide-react";

import appIconUrl from "../../../assets/icon.png?url";
import type {
  TuiAudioDevice,
  TuiLanguage,
  TuiModelHealth,
  TuiNotification,
  TuiSessionPhase,
  TuiSnapshot,
  TuiSourceId,
  TuiSourcePhase,
  TuiSourceState,
  TuiSubtitleEntry,
  TuiSubtitleParagraph,
} from "../../tui/controller.js";
import type { DesktopActionName, DesktopActionPayload, DesktopExportKind } from "./types.js";
import { readSourcePreference, writeSourcePreference } from "./source-preference.js";
import { IconButton, LevelMeter, Toggle } from "./ui.js";
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
  disabled: "待机",
  starting: "正在连接",
  listening: "正在收听",
  paused: "已暂停",
  error: "异常",
};

const SESSION_LABELS: Record<TuiSessionPhase, string> = {
  idle: "尚未开始",
  recording: "正在录制",
  paused: "已暂停",
  saving: "正在保存",
};

const SOURCE_LABELS: Record<TuiSourceId, string> = {
  system: "电脑声音",
  microphone: "麦克风",
};

const MODEL_LABELS = {
  "hy-mt2-plus": "Hunyuan MT2 Plus",
  "hy-mt2-pro": "Hunyuan MT2 Pro",
  "deepseek-v4-flash": "DeepSeek V4 Flash",
  "deepseek-v4-pro": "DeepSeek V4 Pro",
} as const;

const HEALTH_LABELS: Record<TuiModelHealth["status"], string> = {
  idle: "未测试",
  testing: "测试中",
  available: "可用",
  unavailable: "不可用",
  "not-configured": "未配置",
};

function languageLabel(languages: readonly TuiLanguage[], code: string): string {
  const raw = languages.find((item) => item.code === code)?.label ?? code.toUpperCase();
  const localized: Record<string, string> = {
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
  return parts.filter(Boolean).join(/^(?:zh|ja|ko)(?:-|$)/iu.test(language) ? "" : " ");
}

function clockSeconds(value: string): number | undefined {
  const parts = value.split(":").map(Number);
  if (parts.length !== 3 || parts.some((part) => !Number.isFinite(part))) return undefined;
  const [hours = 0, minutes = 0, seconds = 0] = parts;
  return hours * 3600 + minutes * 60 + seconds;
}

function groupIntoParagraphs(entries: readonly TuiSubtitleEntry[]): TranscriptParagraph[] {
  const paragraphs: Array<{ id: string; entries: TuiSubtitleEntry[]; explicitId?: string }> = [];
  for (const entry of entries) {
    const tagged = entry as ParagraphTaggedEntry;
    const current = paragraphs.at(-1);
    const previous = current?.entries.at(-1);
    const explicitChanged = Boolean(tagged.paragraphId && current?.explicitId && tagged.paragraphId !== current.explicitId);
    const gap = previous ? (clockSeconds(entry.timestamp) ?? 0) - (clockSeconds(previous.timestamp) ?? 0) : 0;
    const fallbackBreak = !tagged.paragraphId && Boolean(current && (current.entries.length >= 4 || gap >= 14));
    if (!current || tagged.startsParagraph || tagged.paragraphBreakBefore || explicitChanged || fallbackBreak) {
      paragraphs.push({ id: tagged.paragraphId ?? entry.id, entries: [entry], ...(tagged.paragraphId ? { explicitId: tagged.paragraphId } : {}) });
    } else {
      current.entries.push(entry);
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
        {options.map((option) => <option value={option.value} key={option.value}>{option.label}</option>)}
      </select>
    </label>
  );
}

function ToastStack({
  bridgeError,
  sourceError,
  notifications,
  onDismissBridge,
  onDismissSource,
  onDismissNotification,
}: {
  readonly bridgeError: string | undefined;
  readonly sourceError: string | undefined;
  readonly notifications: readonly TuiNotification[];
  readonly onDismissBridge: () => void;
  readonly onDismissSource: () => void;
  readonly onDismissNotification: (id: string) => void;
}) {
  if (!bridgeError && !sourceError && notifications.length === 0) return null;
  return (
    <div className="toast-stack">
      {bridgeError ? <Toast kind="error" message={bridgeError} onDismiss={onDismissBridge} /> : null}
      {sourceError ? <Toast kind="error" message={sourceError} onDismiss={onDismissSource} /> : null}
      {notifications.map((notification) => (
        <Toast
          key={notification.id}
          kind={notification.kind}
          message={notification.message}
          onDismiss={() => onDismissNotification(notification.id)}
        />
      ))}
    </div>
  );
}

function Toast({
  kind,
  message,
  onDismiss,
}: {
  readonly kind: TuiNotification["kind"];
  readonly message: string;
  readonly onDismiss: () => void;
}) {
  const [leaving, setLeaving] = useState(false);
  const dismissRef = useRef(onDismiss);
  useEffect(() => { dismissRef.current = onDismiss; }, [onDismiss]);
  useEffect(() => {
    setLeaving(false);
    const leaveTimer = window.setTimeout(() => setLeaving(true), 5200);
    const dismissTimer = window.setTimeout(() => dismissRef.current(), 5600);
    return () => { window.clearTimeout(leaveTimer); window.clearTimeout(dismissTimer); };
  }, [message]);
  const Icon = kind === "success" ? CheckCircle2 : AlertCircle;
  return (
    <div className={`toast toast--${kind}${leaving ? " is-leaving" : ""}`} role={kind === "error" ? "alert" : "status"}>
      <Icon aria-hidden="true" />
      <span>{message}</span>
      <button type="button" aria-label="关闭提示" title="关闭提示" onClick={onDismiss}><X aria-hidden="true" /></button>
    </div>
  );
}

function Sidebar({
  page,
  snapshot,
  onNavigate,
  onOpenOverlay,
}: {
  readonly page: AppPage;
  readonly snapshot: TuiSnapshot;
  readonly onNavigate: (page: AppPage) => void;
  readonly onOpenOverlay: () => void;
}) {
  return (
    <aside className="sidebar">
      <div className="sidebar__brand">
        <img src={appIconUrl} alt="" />
        <strong>LiveTranslating</strong>
      </div>
      <nav className="sidebar__nav" aria-label="主导航">
        {([[
          "system", "电脑声音", MonitorSpeaker,
        ], [
          "microphone", "麦克风", Mic,
        ], [
          "settings", "设置", Settings,
        ]] as const).map(([id, label, Icon]) => {
          const session = id === "settings" ? undefined : snapshot.sessions[id];
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
              {session ? <i className={`nav-state nav-state--${session.phase}`} aria-label={SESSION_LABELS[session.phase]} /> : null}
            </button>
          );
        })}
      </nav>
      <div className="sidebar__actions">
        <button className="overlay-command" type="button" onClick={onOpenOverlay}>
          <ExternalLink aria-hidden="true" />
          <span>字幕小窗</span>
        </button>
      </div>
    </aside>
  );
}

function TransportControls({
  phase,
  pending,
  onStart,
  onPause,
  onResume,
  onStop,
}: {
  readonly phase: TuiSessionPhase;
  readonly pending: boolean;
  readonly onStart: () => void;
  readonly onPause: () => void;
  readonly onResume: () => void;
  readonly onStop: () => void;
}) {
  if (phase === "saving") {
    return <IconButton className="transport-button is-saving" icon={LoaderCircle} label="正在保存" disabled />;
  }
  if (phase === "idle") {
    return <IconButton className="transport-button transport-button--play" icon={Play} label="开始新的录制" disabled={pending} onClick={onStart} />;
  }
  return (
    <div className="transport-controls">
      <IconButton
        className="transport-button"
        icon={phase === "paused" ? Play : Pause}
        label={phase === "paused" ? "继续录制" : "暂停录制"}
        disabled={pending}
        onClick={phase === "paused" ? onResume : onPause}
      />
      <IconButton className="transport-button transport-button--stop" icon={Square} label="终止并自动保存" disabled={pending} onClick={onStop} />
    </div>
  );
}

function SourceHeader({
  source,
  sessionPhase,
  devices,
  pending,
  onSelectDevice,
  onStart,
  onPause,
  onResume,
  onStop,
}: {
  readonly source: TuiSourceState;
  readonly sessionPhase: TuiSessionPhase;
  readonly devices: readonly TuiAudioDevice[];
  readonly pending: boolean;
  readonly onSelectDevice: (deviceId: string) => void;
  readonly onStart: () => void;
  readonly onPause: () => void;
  readonly onResume: () => void;
  readonly onStop: () => void;
}) {
  const Icon = source.id === "system" ? MonitorSpeaker : Mic;
  return (
    <header className="source-header">
      <div className="source-header__identity">
        <span className={`source-header__icon source-header__icon--${source.phase}`}><Icon aria-hidden="true" /></span>
        <div><h1>{SOURCE_LABELS[source.id]}</h1><span className={`phase phase--${source.phase}`}>{SESSION_LABELS[sessionPhase]}</span></div>
      </div>
      <div className="source-header__device">
        {source.id === "microphone" ? (
          <label>
            <span>输入设备</span>
            <select value={source.deviceId ?? ""} disabled={pending || devices.length === 0} onChange={(event) => onSelectDevice(event.target.value)}>
              {devices.length === 0 ? <option value="">没有检测到麦克风</option> : null}
              {devices.map((device) => <option value={device.id} key={device.id}>{device.label}{device.isDefault ? "（默认）" : ""}</option>)}
            </select>
          </label>
        ) : (
          <div className="output-device"><span>播放设备</span><strong title={source.deviceLabel}>{source.deviceLabel ?? "Windows 默认播放设备"}</strong></div>
        )}
      </div>
      <div className="source-header__meter"><LevelMeter level={source.level} active={source.phase === "listening"} /></div>
      <dl className="source-header__stats">
        <div><dt>延迟</dt><dd>{source.latencyMs === undefined ? "--" : `${Math.round(source.latencyMs)} ms`}</dd></div>
        <div><dt>丢帧</dt><dd className={source.droppedFrames ? "is-warning" : undefined}>{source.droppedFrames ?? 0}</dd></div>
      </dl>
      <TransportControls phase={sessionPhase} pending={pending} onStart={onStart} onPause={onPause} onResume={onResume} onStop={onStop} />
    </header>
  );
}

function TranscriptReader({
  sourceId,
  entries,
  backendParagraphs,
  sessionPhase,
  sourceLanguage,
  targetLanguage,
}: {
  readonly sourceId: TuiSourceId;
  readonly entries: readonly TuiSubtitleEntry[];
  readonly backendParagraphs: readonly TuiSubtitleParagraph[] | undefined;
  readonly sessionPhase: TuiSessionPhase;
  readonly sourceLanguage: string;
  readonly targetLanguage: string;
}) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const stickToBottom = useRef(true);
  const sourceEntries = useMemo(() => entries.filter((entry) => entry.sourceId === sourceId).slice(-160), [entries, sourceId]);
  const paragraphs = useMemo<TranscriptParagraph[]>(() => backendParagraphs
    ? backendParagraphs.map((paragraph) => ({ id: paragraph.id, entries: paragraph.sentences }))
    : groupIntoParagraphs(sourceEntries), [backendParagraphs, sourceEntries]);
  useEffect(() => {
    if (stickToBottom.current && scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
  }, [sourceEntries.length]);
  const latest = sourceEntries.at(-1);
  const latestAnnounced = latest?.translationOmitted ? "" : (latest?.revisedTranslation ?? latest?.translation ?? "");
  return (
    <div className="transcript-reader" ref={scrollRef} onScroll={() => {
      const element = scrollRef.current;
      if (element) stickToBottom.current = element.scrollHeight - element.scrollTop - element.clientHeight < 72;
    }} tabIndex={0}>
      {paragraphs.length === 0 ? (
        <div className="transcript-empty">
          <Radio aria-hidden="true" />
          <strong>{sessionPhase === "recording" ? "等待下一句话" : sessionPhase === "paused" ? "录制已暂停" : "准备开始同传"}</strong>
          <span>{sessionPhase === "recording" ? "检测到语音后，内容会出现在这里。" : "点击顶部播放按钮开始新的录制。"}</span>
        </div>
      ) : (
        <div className="paragraph-flow">
          {paragraphs.map((paragraph) => {
            const translations = paragraph.entries.filter((entry) => !entry.translationOmitted).map((entry) => (entry.revisedTranslation ?? entry.translation) || "正在翻译…");
            return (
              <article className="transcript-paragraph" key={paragraph.id}>
                <div className="paragraph-meta">
                  <time>{paragraph.entries[0]?.timestamp}</time>
                  {paragraph.entries.some((entry) => entry.revisedTranslation && entry.revisedTranslation !== entry.translation) ? <span><ShieldCheck aria-hidden="true" />已复核</span> : null}
                  {paragraph.entries.every((entry) => entry.translationOmitted) ? <span>目标语言原文</span> : null}
                </div>
                <p className="paragraph-source" lang={sourceLanguage === "auto" ? undefined : sourceLanguage}>{joinSubtitleParts(paragraph.entries.map((entry) => entry.sourceText || "正在识别…"), sourceLanguage)}</p>
                {translations.length > 0 ? <p className="paragraph-translation" lang={targetLanguage}>{joinSubtitleParts(translations, targetLanguage)}</p> : null}
              </article>
            );
          })}
        </div>
      )}
      <span className="sr-only" aria-live="polite" aria-atomic="true">{latestAnnounced}</span>
    </div>
  );
}

function ArchivePanel({
  sourceId,
  snapshot,
  collapsed,
  pending,
  onToggle,
  onRename,
  onExport,
}: {
  readonly sourceId: TuiSourceId;
  readonly snapshot: TuiSnapshot;
  readonly collapsed: boolean;
  readonly pending: boolean;
  readonly onToggle: () => void;
  readonly onRename: (name: string) => void;
  readonly onExport: (kind: DesktopExportKind) => void;
}) {
  const session = snapshot.sessions[sourceId];
  const [draftName, setDraftName] = useState(session.archive.currentName);
  useEffect(() => setDraftName(session.archive.currentName), [session.archive.currentName, sourceId]);
  const commitName = () => {
    const next = draftName.trim();
    if (next && next !== session.archive.currentName) onRename(next);
    else setDraftName(session.archive.currentName);
  };
  if (collapsed) {
    return (
      <aside className="archive-panel is-collapsed">
        <IconButton icon={PanelRightOpen} label="展开保存面板" onClick={onToggle} />
        <FolderArchive aria-hidden="true" />
      </aside>
    );
  }
  const lastSaved = session.archive.lastSaved;
  return (
    <aside className="archive-panel">
      <header className="archive-panel__header">
        <div><strong>保存区域</strong><span>{SOURCE_LABELS[sourceId]}</span></div>
        <IconButton icon={PanelRightClose} label="收回保存面板" onClick={onToggle} />
      </header>
      <div className="archive-panel__body">
        <label className="archive-name-field">
          <span>本次文件名称</span>
          <input
            value={draftName}
            maxLength={96}
            disabled={session.phase === "saving"}
            onChange={(event) => setDraftName(event.target.value)}
            onBlur={commitName}
            onKeyDown={(event) => { if (event.key === "Enter") event.currentTarget.blur(); }}
          />
        </label>
        <div className={`archive-status archive-status--${session.phase}`}>
          <span aria-hidden="true" />
          <div><strong>{SESSION_LABELS[session.phase]}</strong><p>{session.phase === "idle" ? "播放会创建一套全新的文件" : "音频、文字稿与翻译稿同步记录"}</p></div>
        </div>
        <div className="archive-files">
          <div><FileAudio aria-hidden="true" /><span>WAV 分轨录音</span><CheckCircle2 aria-hidden="true" /></div>
          <div><FileText aria-hidden="true" /><span>纯文字稿 · MD</span><CheckCircle2 aria-hidden="true" /></div>
          <div><FileText aria-hidden="true" /><span>双语翻译稿 · MD</span><CheckCircle2 aria-hidden="true" /></div>
        </div>
        <div className="archive-last">
          <span>最近保存</span>
          <strong title={lastSaved?.name}>{lastSaved?.name ?? "暂无归档"}</strong>
          {lastSaved ? <time>{new Date(lastSaved.savedAt).toLocaleString("zh-CN", { hour12: false })}</time> : null}
        </div>
      </div>
      <div className="archive-exports">
        <button type="button" disabled={!lastSaved || pending} onClick={() => onExport("audio")}><Download aria-hidden="true" /><span>导出录音</span></button>
        <button type="button" disabled={!lastSaved || pending} onClick={() => onExport("transcription")}><Download aria-hidden="true" /><span>导出纯文字稿</span></button>
        <button type="button" disabled={!lastSaved || pending} onClick={() => onExport("translation")}><Download aria-hidden="true" /><span>导出双语翻译稿</span></button>
      </div>
    </aside>
  );
}

function SourceView({
  sourceId,
  snapshot,
  pending,
  panelCollapsed,
  onTogglePanel,
  onAction,
  onExport,
}: {
  readonly sourceId: TuiSourceId;
  readonly snapshot: TuiSnapshot;
  readonly pending: boolean;
  readonly panelCollapsed: boolean;
  readonly onTogglePanel: () => void;
  readonly onAction: (name: DesktopActionName, payload?: DesktopActionPayload) => void;
  readonly onExport: (kind: DesktopExportKind) => void;
}) {
  const phase = snapshot.sessions[sourceId].phase;
  return (
    <section className="source-view">
      <SourceHeader
        source={snapshot.sources[sourceId]}
        sessionPhase={phase}
        devices={snapshot.microphoneDevices}
        pending={pending}
        onSelectDevice={(deviceId) => onAction("set-microphone", { deviceId })}
        onStart={() => onAction("start-session", { sourceId })}
        onPause={() => onAction("pause-session", { sourceId })}
        onResume={() => onAction("resume-session", { sourceId })}
        onStop={() => onAction("stop-session", { sourceId })}
      />
      <div className={`source-workspace${panelCollapsed ? " is-panel-collapsed" : ""}`}>
        <TranscriptReader
          sourceId={sourceId}
          entries={snapshot.subtitles}
          backendParagraphs={snapshot.paragraphs?.[sourceId]}
          sessionPhase={phase}
          sourceLanguage={snapshot.sourceLanguage}
          targetLanguage={snapshot.targetLanguage}
        />
        <ArchivePanel
          sourceId={sourceId}
          snapshot={snapshot}
          collapsed={panelCollapsed}
          pending={pending}
          onToggle={onTogglePanel}
          onRename={(name) => onAction("set-archive-name", { sourceId, name })}
          onExport={onExport}
        />
      </div>
    </section>
  );
}

function formatTokens(value: number): string {
  return new Intl.NumberFormat("zh-CN").format(value);
}

function formatCost(value: number, currency: "CNY" | "USD"): string {
  return new Intl.NumberFormat("zh-CN", { style: "currency", currency, minimumFractionDigits: 4, maximumFractionDigits: 6 }).format(value);
}

function SettingsView({
  snapshot,
  pending,
  onAction,
}: {
  readonly snapshot: TuiSnapshot;
  readonly pending: boolean;
  readonly onAction: (name: DesktopActionName, payload?: DesktopActionPayload) => void;
}) {
  const unhealthy = Object.values(snapshot.sources).some((source) => source.phase === "error" || Boolean(source.droppedFrames));
  const modelTesting = snapshot.modelHealth.some((item) => item.status === "testing");
  return (
    <section className="settings-view">
      <div className="settings-sheet">
        <section className="settings-section">
          <h1>翻译</h1>
          <div className="translation-fields translation-fields--target-only">
            <SelectField
              label="翻译成"
              value={snapshot.targetLanguage}
              options={snapshot.targetLanguages.map((language) => ({ value: language.code, label: languageLabel(snapshot.targetLanguages, language.code) }))}
              disabled={pending}
              onChange={(language) => onAction("set-target-language", { language })}
            />
            <SelectField
              label="翻译模型"
              value={snapshot.model}
              options={["hy-mt2-plus", "hy-mt2-pro"].map((value) => ({ value, label: MODEL_LABELS[value as "hy-mt2-plus" | "hy-mt2-pro"] }))}
              disabled={pending}
              onChange={(model) => onAction("set-model", { model: model as TuiSnapshot["model"] })}
            />
          </div>
        </section>

        <section className="settings-section review-settings">
          <h2>复核</h2>
          <div className="settings-row">
            <span className="settings-row__icon"><Layers3 aria-hidden="true" /></span>
            <div><h3>并行翻译候选</h3><p>同时调用未选择的 Hy-MT2；主模型失败时接管，也可作为 DeepSeek 复核证据。</p></div>
            <Toggle checked={snapshot.secondaryTranslationEnabled} disabled={pending} label={`${snapshot.secondaryTranslationEnabled ? "关闭" : "开启"}并行翻译`} onChange={() => onAction("set-secondary-translation", { enabled: !snapshot.secondaryTranslationEnabled })} />
          </div>
          <div className="settings-row">
            <span className="settings-row__icon"><Sparkles aria-hidden="true" /></span>
            <div><h3>DeepSeek V4 Flash 通用复核</h3><p>延迟检查漏译、语义、数字、实体与上下文连贯性。</p></div>
            <Toggle checked={snapshot.reviewerEnabled} disabled={pending} label={`${snapshot.reviewerEnabled ? "关闭" : "开启"}通用复核`} onChange={() => onAction("set-reviewer", { enabled: !snapshot.reviewerEnabled })} />
          </div>
          <div className="settings-row settings-row--with-select">
            <span className="settings-row__icon"><ShieldCheck aria-hidden="true" /></span>
            <div><h3>术语复核</h3><p>{snapshot.reviewQueueSize ? `${snapshot.reviewQueueSize} 条等待处理` : "只修改证据充分的专业词义；不建立术语库。"}</p></div>
            <div className="settings-row__controls">
              <select value={snapshot.terminologyReviewModel} disabled={pending || !snapshot.terminologyReviewEnabled} aria-label="术语复核模型" onChange={(event) => onAction("set-terminology-review-model", { reviewModel: event.target.value === "deepseek-v4-pro" ? "deepseek-v4-pro" : "deepseek-v4-flash" })}>
                <option value="deepseek-v4-flash">V4 Flash</option>
                <option value="deepseek-v4-pro">V4 Pro</option>
              </select>
              <Toggle checked={snapshot.terminologyReviewEnabled} disabled={pending} label={`${snapshot.terminologyReviewEnabled ? "关闭" : "开启"}术语复核`} onChange={() => onAction("set-terminology-review", { enabled: !snapshot.terminologyReviewEnabled })} />
            </div>
          </div>
        </section>

        <section className="settings-section billing-section">
          <div className="settings-heading">
            <h2>Token 与费用估算</h2>
            <button className="compact-command" type="button" disabled={pending || snapshot.billing.pricingReference.status === "checking"} onClick={() => onAction("refresh-pricing")}><RefreshCw aria-hidden="true" />刷新价格参考</button>
          </div>
          <div className="billing-summary">
            <div><span>输入 Token</span><strong>{formatTokens(snapshot.billing.totalInputTokens)}</strong></div>
            <div><span>输出 Token</span><strong>{formatTokens(snapshot.billing.totalOutputTokens)}</strong></div>
            <div><span>请求</span><strong>{snapshot.billing.totalRequests}</strong></div>
            <div><span>估算费用</span><strong>{formatCost(snapshot.billing.totals.CNY ?? 0, "CNY")} + {formatCost(snapshot.billing.totals.USD ?? 0, "USD")}</strong></div>
          </div>
          <div className="billing-table">
            {snapshot.billing.models.map((item) => (
              <div key={item.model}>
                <strong>{MODEL_LABELS[item.model]}</strong>
                <span>{formatTokens(item.inputTokens)} in / {formatTokens(item.outputTokens)} out</span>
                <span>{formatCost(item.cost, item.currency)}</span>
                <span>{item.priceTier ? (item.priceTier === "peak" ? "峰时价" : "谷时价") : "标准价"}</span>
              </div>
            ))}
          </div>
          <p className="pricing-reference">{snapshot.billing.pricingReference.message}。实际账单以厂商为准。</p>
        </section>

        <section className="settings-section">
          <div className="settings-heading"><h2>处理健康</h2><span className={unhealthy ? "is-warning" : "is-healthy"}>{unhealthy ? <AlertCircle aria-hidden="true" /> : <ShieldCheck aria-hidden="true" />}{unhealthy ? "需要注意" : "音频链路正常"}</span></div>
          <div className="health-table">
            {(Object.keys(snapshot.sources) as TuiSourceId[]).map((sourceId) => {
              const source = snapshot.sources[sourceId];
              return <div key={sourceId}><strong>{SOURCE_LABELS[sourceId]}</strong><span className={`phase phase--${source.phase}`}>{PHASE_LABELS[source.phase]}</span><span>{source.latencyMs === undefined ? "--" : `${Math.round(source.latencyMs)} ms`}</span><span className={source.droppedFrames ? "is-warning" : undefined}>{source.droppedFrames ?? 0} 丢帧</span></div>;
            })}
          </div>
          <div className="model-health-heading"><div><h3>模型可用性</h3><p>发送最小请求验证四个模型，会产生少量 Token。</p></div><button className="compact-command" type="button" disabled={modelTesting} onClick={() => onAction("test-models")}><Activity aria-hidden="true" />{modelTesting ? "测试中" : "测试 4 个模型"}</button></div>
          <div className="model-health-grid">
            {snapshot.modelHealth.map((item) => <div key={item.model} className={`model-health model-health--${item.status}`} title={item.error}><strong>{MODEL_LABELS[item.model]}</strong><span>{HEALTH_LABELS[item.status]}</span><small>{item.latencyMs === undefined ? "--" : `${Math.round(item.latencyMs)} ms`}</small></div>)}
          </div>
        </section>

        <section className="settings-section log-section">
          <div className="settings-heading"><h2>运行日志</h2></div>
          <div className="log-list" tabIndex={0}>
            {snapshot.logs.length === 0 ? <p className="settings-empty">暂无日志</p> : snapshot.logs.slice(-80).reverse().map((entry) => <div className={`log-row log-row--${entry.level}`} key={entry.id}><time>{entry.timestamp}</time><span>{entry.source ?? entry.level.toUpperCase()}</span><p>{entry.message}</p></div>)}
          </div>
        </section>
      </div>
    </section>
  );
}

function LoadingShell() {
  return <div className="loading-shell" aria-label="正在连接后端" aria-busy="true"><div className="loading-shell__nav" /><div className="loading-shell__content" /></div>;
}

export function App() {
  const { snapshot, loading, pendingAction, error, connected, invoke, exportArchive, controlWindow, clearError, reconnect } = useDesktopBridge();
  const [page, setPage] = useState<AppPage>(() => readSourcePreference());
  const [panelCollapsed, setPanelCollapsed] = useState(() => window.localStorage.getItem("live-translating:archive-panel") === "collapsed");
  const [dismissedSourceError, setDismissedSourceError] = useState<string>();
  const pending = Boolean(pendingAction || snapshot?.transitioning);
  const navigate = (nextPage: AppPage) => {
    setPage(nextPage);
    if (nextPage !== "settings") writeSourcePreference(nextPage);
  };
  const togglePanel = () => setPanelCollapsed((value) => {
    const next = !value;
    window.localStorage.setItem("live-translating:archive-panel", next ? "collapsed" : "open");
    return next;
  });

  useEffect(() => {
    const handleKeyboard = (event: KeyboardEvent) => {
      const element = event.target as HTMLElement | null;
      if (element?.matches("input, textarea, select, [contenteditable='true']") || event.repeat) return;
      if (event.ctrlKey && event.shiftKey && event.key.toLowerCase() === "s") {
        event.preventDefault();
        void controlWindow("open-overlay");
      }
    };
    window.addEventListener("keydown", handleKeyboard);
    return () => window.removeEventListener("keydown", handleKeyboard);
  }, [controlWindow]);

  if (loading && !snapshot) return <LoadingShell />;
  if (!snapshot) return <main className="fatal-state"><img src={appIconUrl} alt="" /><h1>LiveTranslating 暂时无法连接</h1><p>{error ?? "没有收到后端状态。"}</p><button className="text-button" type="button" onClick={reconnect}>重新连接</button></main>;

  const activeSource = page === "settings" ? undefined : snapshot.sources[page];
  const sourceErrorKey = activeSource?.error ? `${activeSource.id}:${activeSource.error}` : undefined;
  const sourceError = activeSource?.error && sourceErrorKey !== dismissedSourceError ? activeSource.error : undefined;
  return (
    <main className="desktop-app">
      <Sidebar page={page} snapshot={snapshot} onNavigate={navigate} onOpenOverlay={() => void controlWindow("open-overlay")} />
      <div className="content-surface">
        {page === "settings" ? (
          <SettingsView snapshot={snapshot} pending={pending} onAction={(name, payload) => void invoke(name, payload)} />
        ) : (
          <SourceView
            sourceId={page}
            snapshot={snapshot}
            pending={pending || !connected}
            panelCollapsed={panelCollapsed}
            onTogglePanel={togglePanel}
            onAction={(name, payload) => void invoke(name, payload)}
            onExport={(kind) => void exportArchive(page, kind)}
          />
        )}
      </div>
      <ToastStack
        bridgeError={error}
        sourceError={sourceError}
        notifications={snapshot.notifications}
        onDismissBridge={clearError}
        onDismissSource={() => setDismissedSourceError(sourceErrorKey)}
        onDismissNotification={(id) => void invoke("dismiss-notification", { notificationId: id })}
      />
    </main>
  );
}
