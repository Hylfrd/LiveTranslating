import { useCallback, useEffect, useRef, useState } from "react";

import type { TuiSnapshot } from "../../tui/controller.js";
import type {
  DesktopActionName,
  DesktopActionPayload,
  WindowControlCommand,
} from "./types.js";

export interface DesktopBridgeState {
  readonly snapshot: TuiSnapshot | undefined;
  readonly loading: boolean;
  readonly pendingAction: string | undefined;
  readonly error: string | undefined;
  readonly connected: boolean;
  invoke(name: DesktopActionName, payload?: DesktopActionPayload): Promise<void>;
  controlWindow(command: WindowControlCommand): Promise<void>;
  clearError(): void;
  reconnect(): void;
}

function toMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function useDesktopBridge(): DesktopBridgeState {
  const bridge = window.liveTranslating;
  const [snapshot, setSnapshot] = useState<TuiSnapshot>();
  const [loading, setLoading] = useState(true);
  const [pendingAction, setPendingAction] = useState<string>();
  const [error, setError] = useState<string>();
  const [connectionRevision, setConnectionRevision] = useState(0);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    if (!bridge) {
      setLoading(false);
      setError("桌面桥接未连接。请通过 LiveTranslating 桌面程序打开此界面。");
      return () => {
        mounted.current = false;
      };
    }

    setLoading(true);
    setError(undefined);
    const unsubscribe = bridge.onSnapshot((nextSnapshot) => {
      if (mounted.current) {
        setSnapshot(nextSnapshot);
        setLoading(false);
      }
    });
    void bridge.getSnapshot().then((initialSnapshot) => {
      if (mounted.current) {
        setSnapshot(initialSnapshot);
        setLoading(false);
      }
    }).catch((reason: unknown) => {
      if (mounted.current) {
        setLoading(false);
        setError(`无法读取后端状态：${toMessage(reason)}`);
      }
    });

    return () => {
      mounted.current = false;
      unsubscribe();
    };
  }, [bridge, connectionRevision]);

  const invoke = useCallback(async (
    name: DesktopActionName,
    payload?: DesktopActionPayload,
  ) => {
    if (!bridge) {
      setError("桌面桥接未连接，操作没有发送。");
      return;
    }
    setPendingAction(name);
    setError(undefined);
    try {
      await bridge.action(name, payload);
    } catch (reason) {
      setError(`操作失败：${toMessage(reason)}`);
    } finally {
      if (mounted.current) {
        setPendingAction(undefined);
      }
    }
  }, [bridge]);

  const controlWindow = useCallback(async (command: WindowControlCommand) => {
    if (!bridge) {
      setError("桌面桥接未连接，无法控制窗口。");
      return;
    }
    try {
      await bridge.windowControl(command);
    } catch (reason) {
      setError(`窗口操作失败：${toMessage(reason)}`);
    }
  }, [bridge]);

  return {
    snapshot,
    loading,
    pendingAction,
    error,
    connected: Boolean(bridge),
    invoke,
    controlWindow,
    clearError: () => setError(undefined),
    reconnect: () => setConnectionRevision((value) => value + 1),
  };
}
