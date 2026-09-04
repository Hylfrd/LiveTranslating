import { useEffect, useMemo, useRef, useState } from "react";
import { AlertCircle, Bug, CircleAlert, Info, Radio, Search } from "lucide-react";

import type { TuiLogLevel } from "../../tui/controller.js";
import { useDesktopBridge } from "./use-desktop-bridge.js";

const LEVELS: ReadonlyArray<{
  readonly level: TuiLogLevel;
  readonly label: string;
  readonly icon: typeof Info;
}> = [
  { level: "error", label: "错误", icon: AlertCircle },
  { level: "warn", label: "警告", icon: CircleAlert },
  { level: "info", label: "信息", icon: Info },
  { level: "debug", label: "调试", icon: Bug },
];

export function LogApp() {
  const { snapshot, loading, error, clearError } = useDesktopBridge();
  const [levels, setLevels] = useState<Record<TuiLogLevel, boolean>>({
    error: true,
    warn: true,
    info: true,
    debug: false,
  });
  const [source, setSource] = useState("all");
  const [query, setQuery] = useState("");
  const [follow, setFollow] = useState(true);
  const scrollRef = useRef<HTMLDivElement>(null);
  const sources = useMemo(() => [...new Set((snapshot?.logs ?? []).map((entry) => entry.source ?? "app"))].sort(), [snapshot?.logs]);
  const normalizedQuery = query.trim().toLocaleLowerCase();
  const entries = useMemo(() => (snapshot?.logs ?? [])
    .filter((entry) => levels[entry.level])
    .filter((entry) => source === "all" || (entry.source ?? "app") === source)
    .filter((entry) => !normalizedQuery || `${entry.source ?? "app"} ${entry.message}`.toLocaleLowerCase().includes(normalizedQuery))
    .slice()
    .reverse(), [levels, normalizedQuery, snapshot?.logs, source]);
  const latestId = snapshot?.logs.at(-1)?.id;

  useEffect(() => {
    if (follow && scrollRef.current) scrollRef.current.scrollTop = 0;
  }, [follow, latestId]);

  const counts = useMemo(() => Object.fromEntries(LEVELS.map(({ level }) => [
    level,
    (snapshot?.logs ?? []).filter((entry) => entry.level === level).length,
  ])) as Record<TuiLogLevel, number>, [snapshot?.logs]);

  return (
    <main className="log-app">
      <header className="log-toolbar">
        <div className="log-title"><Radio aria-hidden="true" /><div><h1>运行日志</h1><span>{snapshot?.logs.length ?? 0} 条记录</span></div></div>
        <label className="log-search"><Search aria-hidden="true" /><input value={query} placeholder="搜索来源或消息" aria-label="搜索日志" onChange={(event) => setQuery(event.target.value)} /></label>
        <select value={source} aria-label="筛选日志来源" onChange={(event) => setSource(event.target.value)}>
          <option value="all">全部来源</option>
          {sources.map((value) => <option value={value} key={value}>{value}</option>)}
        </select>
        <label className="log-follow"><input type="checkbox" checked={follow} onChange={(event) => setFollow(event.target.checked)} /><span>实时跟随</span></label>
      </header>

      <div className="log-levels" aria-label="日志等级筛选">
        {LEVELS.map(({ level, label, icon: Icon }) => (
          <label className={`log-level log-level--${level}`} key={level}>
            <input type="checkbox" checked={levels[level]} onChange={() => setLevels((current) => ({ ...current, [level]: !current[level] }))} />
            <Icon aria-hidden="true" />
            <span>{label}</span>
            <strong>{counts[level]}</strong>
          </label>
        ))}
      </div>

      {error ? <div className="log-error" role="alert"><AlertCircle aria-hidden="true" /><span>{error}</span><button type="button" onClick={clearError}>关闭</button></div> : null}

      <div className="log-table" ref={scrollRef} aria-busy={loading} onScroll={() => {
        const element = scrollRef.current;
        if (element && element.scrollTop > 36 && follow) setFollow(false);
      }}>
        <div className="log-table__head"><span>时间</span><span>等级</span><span>来源</span><span>消息</span></div>
        {entries.length === 0 ? (
          <div className="log-empty"><Search aria-hidden="true" /><strong>没有匹配的日志</strong><span>调整等级、来源或搜索条件。</span></div>
        ) : entries.map((entry, index) => (
          <article className={`log-entry log-entry--${entry.level}${index === 0 ? " is-latest" : ""}`} key={entry.id}>
            <time>{entry.timestamp}</time>
            <span className="log-entry__level">{entry.level === "warn" ? "警告" : entry.level === "error" ? "错误" : entry.level === "debug" ? "调试" : "信息"}</span>
            <strong title={entry.source ?? "app"}>{entry.source ?? "app"}</strong>
            <p>{entry.message}</p>
          </article>
        ))}
      </div>
    </main>
  );
}
