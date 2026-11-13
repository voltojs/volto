/**
 * Event Bridge
 * 将 EventSink 桥接到 IPC，使渲染进程可以接收 agent 事件
 */

import { BrowserWindow } from "electron";
import type { EventSink } from "@voltojs/core";

/** Agent 事件类型 */
export interface AgentEvent {
  type: string;
  data: Record<string, unknown>;
  timestamp: number;
}

/**
 * 创建 IPC EventSink
 * 将 agent 事件通过 IPC 发送到渲染进程
 */
export function createIpcEventSink(): EventSink {
  return {
    emit(event: { type: string; data: Record<string, unknown> }) {
      const agentEvent: AgentEvent = {
        ...event,
        timestamp: Date.now(),
      };

      // 获取所有窗口并发送事件
      const windows = BrowserWindow.getAllWindows();
      for (const window of windows) {
        if (!window.isDestroyed()) {
          window.webContents.send("agent:event", agentEvent);
        }
      }
    },
  };
}

/**
 * 创建带缓冲的 IPC EventSink
 * 在渲染进程未准备好时缓冲事件
 */
export function createBufferedIpcEventSink(): EventSink & { flush: () => void } {
  const buffer: AgentEvent[] = [];
  let isReady = false;

  const flush = () => {
    isReady = true;
    const windows = BrowserWindow.getAllWindows();
    for (const window of windows) {
      if (!window.isDestroyed()) {
        for (const event of buffer) {
          window.webContents.send("agent:event", event);
        }
      }
    }
    buffer.length = 0;
  };

  return {
    emit(event: { type: string; data: Record<string, unknown> }) {
      const agentEvent: AgentEvent = {
        ...event,
        timestamp: Date.now(),
      };

      if (isReady) {
        const windows = BrowserWindow.getAllWindows();
        for (const window of windows) {
          if (!window.isDestroyed()) {
            window.webContents.send("agent:event", agentEvent);
          }
        }
      } else {
        buffer.push(agentEvent);
      }
    },
    flush,
  };
}
