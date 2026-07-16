/**
 * Debug Store
 * 调试视图的瞬态数据源：所有 EventSink 推送的 agent 事件先 append 这里，
 * Phase 6 的 StateInspector / EventTimeline / ToolTracer / LogViewer / ReplayControls
 * 都基于这份数据驱动。
 *
 * 设计要点：
 * - **瞬态**：不写入 electron-store，重启清空，避免污染主数据
 * - **环形缓冲**：保留最近 MAX_EVENTS 条，防长跑会话内存膨胀
 * - **回放仅在客户端**：不真正 pause agent 主循环；`replayCursor` 只决定
 *   渲染视图截取到第几条事件，默认为 events.length（=最新一条）
 */

import { create } from "zustand";
import type { AgentEvent } from "@/renderer/src/types/agent";

/** 调试事件 = AgentEvent 加上一个稳定 seq 用于排序与游标 */
export interface DebugEvent extends AgentEvent {
  /** 单调自增序号，唯一确定事件在时间轴上的位置 */
  seq: number;
}

/** 环形缓冲容量；超出后从头丢弃 */
export const MAX_EVENTS = 5000;

export interface DebugState {
  /** 累计事件（已包含 seq） */
  events: DebugEvent[];
  /**
   * 回放游标：渲染层截取到第几条（exclusive end）。
   * - 实时模式下 `cursor === events.length`
   * - 用户拖动 slider 进入"回放模式"时 `cursor < events.length`
   */
  cursor: number;
  /** 是否处于回放模式 */
  isReplaying: boolean;
  /** 用户在 LogViewer 输入的关键字（影响所有面板的次级过滤） */
  filter: string;
  /** 主进程拉回的最新 agent state 快照（按需更新） */
  latestState: unknown | null;
}

export interface DebugActions {
  /** EventSink → IPC → use-stream 的事件 push 入口 */
  pushEvent: (event: AgentEvent) => void;
  /** 清空全部事件（仅本地，不影响 agent） */
  clear: () => void;
  /** 设置 cursor；写入此函数即视为进入"回放模式" */
  setCursor: (cursor: number) => void;
  /** 退出回放，回到实时 */
  resumeLive: () => void;
  /** 单步前进 / 后退 */
  step: (delta: number) => void;
  /** 设置过滤词 */
  setFilter: (filter: string) => void;
  /** 缓存最新 state */
  setLatestState: (state: unknown) => void;

  /** 取当前 cursor 切片下的事件视图（保持引用稳定） */
  getVisibleEvents: () => DebugEvent[];
}

let seqCounter = 0;
function nextSeq(): number {
  seqCounter += 1;
  return seqCounter;
}

export const useDebugStore = create<DebugState & DebugActions>((set, get) => ({
  events: [],
  cursor: 0,
  isReplaying: false,
  filter: "",
  latestState: null,

  pushEvent: (event) => {
    set((state) => {
      const debugEvent: DebugEvent = { ...event, seq: nextSeq() };
      let nextEvents = [...state.events, debugEvent];
      // 环形丢弃最旧条目（slice 一次比 shift 多次成本低）
      if (nextEvents.length > MAX_EVENTS) {
        nextEvents = nextEvents.slice(nextEvents.length - MAX_EVENTS);
      }
      // 实时模式下 cursor 跟随末尾；回放模式下保持原 cursor
      const nextCursor = state.isReplaying ? state.cursor : nextEvents.length;
      return { events: nextEvents, cursor: nextCursor };
    });
  },

  clear: () => set({ events: [], cursor: 0, isReplaying: false }),

  setCursor: (cursor) =>
    set((state) => {
      const clamped = Math.max(0, Math.min(cursor, state.events.length));
      const replaying = clamped < state.events.length;
      return { cursor: clamped, isReplaying: replaying };
    }),

  resumeLive: () => set((state) => ({ cursor: state.events.length, isReplaying: false })),

  step: (delta) =>
    set((state) => {
      const next = Math.max(0, Math.min(state.cursor + delta, state.events.length));
      const replaying = next < state.events.length;
      return { cursor: next, isReplaying: replaying };
    }),

  setFilter: (filter) => set({ filter }),

  setLatestState: (latestState) => set({ latestState }),

  getVisibleEvents: () => {
    const { events, cursor, filter } = get();
    const sliced = events.slice(0, cursor);
    if (!filter) return sliced;
    const needle = filter.toLowerCase();
    return sliced.filter((e) => {
      if (e.type.toLowerCase().includes(needle)) return true;
      try {
        return JSON.stringify(e.data).toLowerCase().includes(needle);
      } catch {
        return false;
      }
    });
  },
}));
