/**
 * use-debug.ts
 * Debug 视图的辅助 hook：封装"按需拉取主进程 agent state"和"清理 debug 数据"
 * 等命令式操作，避免组件直接捅 IPC 或 store action。
 *
 * 数据读取仍走 `useDebugStore` 选择器（组件按需订阅 events / cursor / filter
 * 即可），本 hook 只暴露不适合做 hook subscriber 的命令式动作。
 */

import { useCallback } from "react";
import { useDebugStore } from "@/renderer/src/stores/debug-store";

export function useDebug() {
  const setLatestState = useDebugStore((s) => s.setLatestState);
  const clear = useDebugStore((s) => s.clear);
  const setCursor = useDebugStore((s) => s.setCursor);
  const step = useDebugStore((s) => s.step);
  const resumeLive = useDebugStore((s) => s.resumeLive);
  const setFilter = useDebugStore((s) => s.setFilter);

  /**
   * 主动从主进程拉取最新 agent state 快照。
   * 失败时记日志但不抛——调试视图刷新失败不应该传染到主路径。
   */
  const refreshState = useCallback(async () => {
    if (typeof window === "undefined" || !window.electronAPI?.agent) return;
    try {
      const state = await window.electronAPI.agent.getState();
      setLatestState(state);
    } catch (err) {
      console.error("[use-debug] refreshState failed:", err);
    }
  }, [setLatestState]);

  return {
    refreshState,
    clear,
    setCursor,
    step,
    resumeLive,
    setFilter,
  };
}
