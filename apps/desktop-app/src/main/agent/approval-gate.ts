/**
 * approval-gate.ts
 * 主进程 ApprovalGate 实现：把内核要求的 HITL approval 通过 IPC 桥到渲染进程的
 * ApprovalDialog；渲染端 decide 后通过另一条 IPC 通道回写。
 *
 * 设计要点：
 * - 用 `pendingApprovals: Map<requestId, { resolve, reject, payload }>` 跟踪挂着的请求
 * - `ask()` 创建一条 pending、push 给所有窗口（`agent:approval-request`），返回 Promise
 * - 渲染端 `agent:approval-decision` invoke 写回结果，主进程查表 resolve
 * - 单条请求最长 `approvalTimeoutMs`（默认 5 分钟）；超时按 "deny" 处理并清掉记录
 * - `dispose()` 关掉所有挂起请求（main 窗口关闭时调用），避免 promise 泄漏
 * - 所有错误吞在边界内：内核拿到的永远是 "allow" | "deny"，**绝不抛**
 */

import { BrowserWindow } from "electron";
import type { ApprovalGate, PendingToolCall, RiskTier } from "@voltojs/core";

/** 一条挂起的 approval 请求（主进程内部） */
interface PendingApproval {
  resolve: (decision: "allow" | "deny") => void;
  timer: NodeJS.Timeout;
}

/** 推送给渲染进程的请求载荷 */
export interface ApprovalRequestPayload {
  requestId: string;
  toolCallId: string;
  toolName: string;
  args: Record<string, unknown>;
  riskTier: RiskTier;
  /** 主进程墙钟，仅供 UI 展示；不入内核 */
  requestedAt: number;
  /** 发起这次审批请求的聊天会话 id，供渲染端按会话路由/展示 */
  sessionId: string;
}

export interface ApprovalGateOptions {
  /** 超时未决策视为 deny；默认 5 分钟 */
  approvalTimeoutMs?: number;
  /** 单元测试或离屏模式注入替换的广播函数 */
  broadcast?: (channel: string, payload: ApprovalRequestPayload) => void;
}

/** 自增 requestId，避免依赖随机源（apps 层允许 Date.now，但每条独立 id 用计数更稳） */
const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000;

/** 创建一个 ApprovalGate 实例（与 IPC handlers 共享一个 pendingApprovals 表） */
export function createApprovalGate(options: ApprovalGateOptions = {}): {
  /** 按 sessionId 生成一个 ApprovalGate 包装——ask() 内部自动带上该 sessionId */
  gateFor: (sessionId: string) => ApprovalGate;
  /** 渲染端写回决策 */
  decide: (requestId: string, decision: "allow" | "deny") => boolean;
  /** 关闭所有挂起请求（自动 deny），用于 app quit / agent destroy 路径 */
  dispose: () => void;
  /** 当前挂起请求的快照，仅用于调试 / 测试 */
  inspect: () => ApprovalRequestPayload[];
} {
  const timeoutMs = options.approvalTimeoutMs ?? DEFAULT_TIMEOUT_MS;
  const pending = new Map<string, PendingApproval>();
  /** 也保存载荷副本以便 inspect / 二次广播（如新打开窗口需要补发） */
  const payloads = new Map<string, ApprovalRequestPayload>();
  /** 每个 gate 实例独立的自增计数（多实例时不串号） */
  let requestCounter = 0;
  const nextRequestId = (): string => {
    requestCounter += 1;
    return `appr_${Date.now().toString(36)}_${requestCounter.toString(36)}`;
  };

  const broadcast = options.broadcast
    ?? ((channel, payload) => {
      for (const win of BrowserWindow.getAllWindows()) {
        win.webContents.send(channel, payload);
      }
    });

  const ask = async (
    call: PendingToolCall,
    riskTier: RiskTier,
    sessionId: string,
  ): Promise<"allow" | "deny"> => {
    const requestId = nextRequestId();
    const payload: ApprovalRequestPayload = {
      requestId,
      toolCallId: call.id,
      toolName: call.name,
      args: call.input ?? {},
      riskTier,
      requestedAt: Date.now(),
      sessionId,
    };
    payloads.set(requestId, payload);

    return new Promise<"allow" | "deny">((resolve) => {
      const timer = setTimeout(() => {
        // 超时未决策一律 deny；同时清理表，避免悬挂回写
        pending.delete(requestId);
        payloads.delete(requestId);
        resolve("deny");
      }, timeoutMs);

      pending.set(requestId, { resolve, timer });

      try {
        broadcast("agent:approval-request", payload);
      } catch (err) {
        // 广播失败不影响内核；视为立即 deny
        clearTimeout(timer);
        pending.delete(requestId);
        payloads.delete(requestId);
        console.error("[approval-gate] broadcast failed:", err);
        resolve("deny");
      }
    });
  };

  const decide = (requestId: string, decision: "allow" | "deny"): boolean => {
    const entry = pending.get(requestId);
    if (!entry) return false; // 已超时 / 重复决策
    clearTimeout(entry.timer);
    pending.delete(requestId);
    payloads.delete(requestId);
    entry.resolve(decision);
    return true;
  };

  const dispose = (): void => {
    for (const [, entry] of pending) {
      clearTimeout(entry.timer);
      entry.resolve("deny");
    }
    pending.clear();
    payloads.clear();
  };

  const inspect = (): ApprovalRequestPayload[] => {
    return Array.from(payloads.values());
  };

  return {
    gateFor: (sessionId: string) => ({
      ask: (call, riskTier) => ask(call, riskTier, sessionId),
    }),
    decide,
    dispose,
    inspect,
  };
}
