import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Box, Text, useApp, useInput, useStdout } from "ink";

import {
  getLanguageLabel,
  type TuiActionResult,
  type TuiController,
  type TuiSnapshot,
  type TuiSourceId,
  type TuiSourceState,
} from "./controller.js";
import { logColor, phaseColor, tuiColors } from "./theme.js";

type MenuItemId =
  | "system"
  | "microphone"
  | "device"
  | "recording"
  | "sourceLanguage"
  | "targetLanguage"
  | "model"
  | "reviewer"
  | "glossary";

interface MenuItem {
  readonly id: MenuItemId;
  readonly label: string;
  readonly value: string;
}

export interface TuiAppProps {
  readonly controller: TuiController;
  readonly title?: string;
  readonly onError?: (error: unknown) => void;
}

function boolLabel(value: boolean): string {
  return value ? "ON" : "OFF";
}

function clampLevel(level: number | undefined): number {
  if (level === undefined || !Number.isFinite(level)) {
    return 0;
  }
  return Math.min(1, Math.max(0, level));
}

function meter(level: number | undefined, width = 12): string {
  const active = Math.round(clampLevel(level) * width);
  return `${"#".repeat(active)}${"-".repeat(width - active)}`;
}

function sourceDetails(source: TuiSourceState): string {
  const details: string[] = [];
  if (source.deviceLabel) {
    details.push(source.deviceLabel);
  }
  if (source.latencyMs !== undefined) {
    details.push(`${Math.round(source.latencyMs)} ms`);
  }
  if (source.droppedFrames) {
    details.push(`${source.droppedFrames} dropped`);
  }
  return details.join(" | ");
}

function SourcePanel({ source }: { readonly source: TuiSourceState }) {
  return (
    <Box flexDirection="column" width="50%" paddingRight={2}>
      <Box>
        <Text color={source.enabled ? tuiColors.accent : tuiColors.dim} bold>
          {source.enabled ? "[x]" : "[ ]"} {source.label}
        </Text>
        <Text color={phaseColor(source.phase)}>  {source.phase.toUpperCase()}</Text>
      </Box>
      <Text color={source.enabled ? tuiColors.ok : tuiColors.dim}>
        {meter(source.level)}
      </Text>
      <Text color={tuiColors.dim} wrap="truncate-end">
        {sourceDetails(source) || "No active device"}
      </Text>
      {source.error ? (
        <Text color={tuiColors.error} wrap="truncate-end">
          {source.error}
        </Text>
      ) : null}
    </Box>
  );
}

function Header({ snapshot, title }: { readonly snapshot: TuiSnapshot; readonly title: string }) {
  const state = snapshot.transitioning
    ? "CHANGING"
    : snapshot.running
      ? "RUNNING"
      : "STOPPED";
  const stateColor = snapshot.transitioning
    ? tuiColors.warning
    : snapshot.running
      ? tuiColors.ok
      : tuiColors.dim;

  return (
    <Box justifyContent="space-between">
      <Text bold color={tuiColors.accent}>{title}</Text>
      <Text>
        <Text color={stateColor} bold>{state}</Text>
        <Text color={snapshot.recording ? tuiColors.error : tuiColors.dim}>
          {snapshot.recording ? "  REC" : "  REC OFF"}
        </Text>
        <Text color={tuiColors.dim}>  {snapshot.model}</Text>
      </Text>
    </Box>
  );
}

function SubtitlePanel({ snapshot }: { readonly snapshot: TuiSnapshot }) {
  const recent = snapshot.subtitles.slice(-3);

  return (
    <Box flexDirection="column" borderStyle="single" borderColor={tuiColors.dim} paddingX={1}>
      <Text bold>Recent subtitles</Text>
      {recent.length === 0 ? (
        <Text color={tuiColors.dim}>Waiting for speech...</Text>
      ) : (
        recent.map((entry) => (
          <Box key={entry.id} flexDirection="column" marginTop={1}>
            <Text color={tuiColors.dim}>
              {entry.timestamp}  {entry.sourceId}  {entry.isFinal ? "final" : "partial"}
            </Text>
            <Text wrap="truncate-end">
              {snapshot.sourceLanguage.toUpperCase().padEnd(3)} {entry.sourceText || "..."}
            </Text>
            <Text color={tuiColors.accent} wrap="truncate-end">
              {snapshot.targetLanguage.toUpperCase().padEnd(3)} {entry.translation || "..."}
            </Text>
            {entry.revisedTranslation && entry.revisedTranslation !== entry.translation ? (
              <Text color={tuiColors.warning} wrap="truncate-end">
                REV {entry.revisedTranslation}
              </Text>
            ) : null}
          </Box>
        ))
      )}
    </Box>
  );
}

function LogPanel({ snapshot, limit }: { readonly snapshot: TuiSnapshot; readonly limit: number }) {
  const logs = snapshot.logs.slice(-limit);

  return (
    <Box flexDirection="column" borderStyle="single" borderColor={tuiColors.dim} paddingX={1}>
      <Text bold>Logs</Text>
      {logs.length === 0 ? (
        <Text color={tuiColors.dim}>No log entries</Text>
      ) : (
        logs.map((entry) => (
          <Text key={entry.id} color={logColor(entry.level)} wrap="truncate-end">
            {entry.timestamp} {entry.level.toUpperCase().padEnd(5)}
            {entry.source ? ` [${entry.source}]` : ""} {entry.message}
          </Text>
        ))
      )}
    </Box>
  );
}

export function TuiApp({ controller, title = "LiveTranslating", onError }: TuiAppProps) {
  const { exit } = useApp();
  const { stdout } = useStdout();
  const [snapshot, setSnapshot] = useState<TuiSnapshot>(() => controller.getSnapshot());
  const [selection, setSelection] = useState(0);
  const [actionError, setActionError] = useState<string>();
  const [actionPending, setActionPending] = useState(false);
  const [quitting, setQuitting] = useState(false);
  const quittingRef = useRef(false);

  const terminalColumns = stdout?.columns ?? 80;
  const terminalRows = stdout?.rows ?? 40;
  const terminalTooSmall = terminalColumns < 72 || terminalRows < 30;

  useEffect(() => controller.subscribe(setSnapshot), [controller]);

  const menuItems = useMemo<readonly MenuItem[]>(() => {
    const microphone = snapshot.sources.microphone;
    return [
      {
        id: "system",
        label: "System audio",
        value: boolLabel(snapshot.sources.system.enabled),
      },
      {
        id: "microphone",
        label: "Microphone",
        value: boolLabel(microphone.enabled),
      },
      {
        id: "device",
        label: "Mic device",
        value: microphone.deviceLabel ?? "No device",
      },
      {
        id: "recording",
        label: "Save recording",
        value: boolLabel(snapshot.recording),
      },
      {
        id: "sourceLanguage",
        label: "Source language",
        value: getLanguageLabel(snapshot.sourceLanguages, snapshot.sourceLanguage),
      },
      {
        id: "targetLanguage",
        label: "Target language",
        value: getLanguageLabel(snapshot.targetLanguages, snapshot.targetLanguage),
      },
      { id: "model", label: "Primary model", value: snapshot.model },
      {
        id: "reviewer",
        label: "DeepSeek review",
        value: snapshot.reviewerEnabled
          ? `ON${snapshot.reviewQueueSize ? ` (${snapshot.reviewQueueSize} queued)` : ""}`
          : "OFF",
      },
      {
        id: "glossary",
        label: "Session glossary",
        value: `${snapshot.glossaryCount} terms`,
      },
    ];
  }, [snapshot]);

  const reportError = useCallback((error: unknown) => {
    setActionError(error instanceof Error ? error.message : String(error));
    onError?.(error);
  }, [onError]);

  const runAction = useCallback((action: () => TuiActionResult) => {
    if (actionPending) {
      return;
    }
    setActionPending(true);
    setActionError(undefined);
    try {
      void Promise.resolve(action()).catch(reportError).finally(() => setActionPending(false));
    } catch (error) {
      reportError(error);
      setActionPending(false);
    }
  }, [actionPending, reportError]);

  const quit = useCallback(() => {
    if (quittingRef.current) {
      return;
    }
    quittingRef.current = true;
    setQuitting(true);
    void (async () => {
      try {
        await controller.shutdown();
      } catch (error) {
        reportError(error);
      } finally {
        exit();
      }
    })();
  }, [controller, exit, reportError]);

  const activate = useCallback((itemId: MenuItemId) => {
    switch (itemId) {
      case "system":
      case "microphone":
        runAction(() => controller.toggleSource(itemId satisfies TuiSourceId));
        break;
      case "device":
        runAction(() => controller.cycleMicrophoneDevice(1));
        break;
      case "recording":
        runAction(() => controller.toggleRecording());
        break;
      case "sourceLanguage":
        runAction(() => controller.cycleSourceLanguage(1));
        break;
      case "targetLanguage":
        runAction(() => controller.cycleTargetLanguage(1));
        break;
      case "model":
        runAction(() => controller.cycleModel(1));
        break;
      case "reviewer":
        runAction(() => controller.toggleReviewer());
        break;
      case "glossary":
        runAction(() => controller.reloadGlossary());
        break;
    }
  }, [controller, runAction]);

  useInput((input, key) => {
    if (input === "q") {
      quit();
      return;
    }
    if (terminalTooSmall) {
      return;
    }
    if (key.upArrow || input === "k") {
      setSelection((current) => (current - 1 + menuItems.length) % menuItems.length);
      return;
    }
    if (key.downArrow || input === "j") {
      setSelection((current) => (current + 1) % menuItems.length);
      return;
    }
    if (key.return) {
      runAction(() => controller.toggleRunning());
      return;
    }
    if (input === " ") {
      const selected = menuItems[selection];
      if (selected) {
        activate(selected.id);
      }
      return;
    }
    if (input === "d") {
      runAction(() => controller.cycleMicrophoneDevice(1));
    } else if (input === "m") {
      runAction(() => controller.cycleModel(1));
    } else if (input === "l") {
      const selected = menuItems[selection];
      if (selected?.id === "sourceLanguage") {
        runAction(() => controller.cycleSourceLanguage(1));
      } else {
        runAction(() => controller.cycleTargetLanguage(1));
      }
    } else if (input === "r") {
      runAction(() => controller.toggleRecording());
    } else if (input === "v") {
      runAction(() => controller.toggleReviewer());
    } else if (input === "g") {
      runAction(() => controller.reloadGlossary());
    }
  });

  if (terminalTooSmall) {
    return (
      <Box flexDirection="column" paddingX={1}>
        <Text bold color={tuiColors.accent}>{title}</Text>
        <Text color={tuiColors.warning}>Terminal is too small for the dashboard.</Text>
        <Text>
          Current: {terminalColumns} x {terminalRows}  Minimum: 72 x 30
        </Text>
        <Text color={tuiColors.dim}>Resize the terminal, or press q to quit.</Text>
        {quitting ? <Text color={tuiColors.warning}>Shutting down...</Text> : null}
        {actionError ? <Text color={tuiColors.error}>Action failed: {actionError}</Text> : null}
      </Box>
    );
  }

  const logLimit = terminalRows >= 42 ? 10 : 8;

  return (
    <Box flexDirection="column" paddingX={1}>
      <Header snapshot={snapshot} title={title} />
      {actionError ? <Text color={tuiColors.error}>Action failed: {actionError}</Text> : null}
      {quitting ? (
        <Text color={tuiColors.warning}>Shutting down...</Text>
      ) : actionPending ? (
        <Text color={tuiColors.warning}>Applying action...</Text>
      ) : null}
      <Box marginTop={1}>
        <SourcePanel source={snapshot.sources.system} />
        <SourcePanel source={snapshot.sources.microphone} />
      </Box>

      <Box flexDirection="column" borderStyle="single" borderColor={tuiColors.dim} paddingX={1} marginTop={1}>
        {menuItems.map((item, index) => {
          const selected = index === selection;
          return (
            <Box key={item.id}>
              <Text color={selected ? tuiColors.accent : tuiColors.dim}>
                {selected ? ">" : " "} {item.label.padEnd(20)}
              </Text>
              <Text bold={selected} wrap="truncate-end">{item.value}</Text>
            </Box>
          );
        })}
      </Box>

      <SubtitlePanel snapshot={snapshot} />
      <LogPanel snapshot={snapshot} limit={logLimit} />

      <Text color={tuiColors.dim} wrap="truncate-end">
        Up/Down or j/k select  Space toggle  Enter start/stop  d device  m model  l language  r record  v review  g glossary  q quit
      </Text>
    </Box>
  );
}
