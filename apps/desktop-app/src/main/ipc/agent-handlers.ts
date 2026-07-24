/**
 * Agent 相关 IPC 处理器
 * 提供 agent 的消息发送、流式输出、会话管理等功能
 */

import { type IpcMainInvokeEvent } from "electron";
import { getAgentManager } from "../agent/agent-manager.js";
import type { ApprovalRequestPayload } from "../agent/approval-gate.js";
import { createIpcChannel, type AnyIpcChannel, type IpcChannel } from "./handlers.js";

/** 创建 agent 请求参数 */
export interface CreateAgentArgs {
  sessionId: string;
}

/** 发送消息请求参数 */
export interface SendMessageArgs {
  sessionId: string;
  message: string;
}

/** 恢复会话请求参数 */
export interface ResumeSessionArgs {
  sessionId: string;
  resumeId: string;
  decision: "allow" | "deny";
}

/** 获取状态/state/销毁的通用参数 */
export interface SessionScopedArgs {
  sessionId: string;
}

/** 审批决策请求参数 */
export interface ApprovalDecisionArgs {
  requestId: string;
  decision: "allow" | "deny";
}

/** 创建 agent:create 处理器 */
function createAgentCreateHandler(): IpcChannel<CreateAgentArgs, { success: boolean; error?: string }> {
  return createIpcChannel<CreateAgentArgs, { success: boolean; error?: string }>(
    "agent:create",
    async (_event: IpcMainInvokeEvent, args: CreateAgentArgs) => {
      try {
        const manager = getAgentManager();
        manager.create(args.sessionId);
        return { success: true };
      } catch (error) {
        return {
          success: false,
          error: error instanceof Error ? error.message : String(error),
        };
      }
    },
  );
}

/** 创建 agent:send-message 处理器 */
function createAgentSendMessageHandler(): IpcChannel<SendMessageArgs, { success: boolean; error?: string }> {
  return createIpcChannel<SendMessageArgs, { success: boolean; error?: string }>(
    "agent:send-message",
    async (_event: IpcMainInvokeEvent, args: SendMessageArgs) => {
      try {
        const manager = getAgentManager();
        await manager.run(args.sessionId, args.message);
        return { success: true };
      } catch (error) {
        return {
          success: false,
          error: error instanceof Error ? error.message : String(error),
        };
      }
    },
  );
}

/** 创建 agent:resume 处理器 */
function createAgentResumeHandler(): IpcChannel<ResumeSessionArgs, { success: boolean; error?: string }> {
  return createIpcChannel<ResumeSessionArgs, { success: boolean; error?: string }>(
    "agent:resume",
    async (_event: IpcMainInvokeEvent, args: ResumeSessionArgs) => {
      try {
        const manager = getAgentManager();
        await manager.resume(args.sessionId, args.resumeId, args.decision);
        return { success: true };
      } catch (error) {
        return {
          success: false,
          error: error instanceof Error ? error.message : String(error),
        };
      }
    },
  );
}

/** 创建 agent:get-status 处理器 */
function createAgentGetStatusHandler(): IpcChannel<SessionScopedArgs, string> {
  return createIpcChannel<SessionScopedArgs, string>(
    "agent:get-status",
    (_event: IpcMainInvokeEvent, args: SessionScopedArgs) => {
      const manager = getAgentManager();
      return manager.getStatus(args.sessionId);
    },
  );
}

/** 创建 agent:get-state 处理器 */
function createAgentGetStateHandler(): IpcChannel<SessionScopedArgs, unknown> {
  return createIpcChannel<SessionScopedArgs, unknown>(
    "agent:get-state",
    (_event: IpcMainInvokeEvent, args: SessionScopedArgs) => {
      const manager = getAgentManager();
      return manager.getState(args.sessionId);
    },
  );
}

/** 创建 agent:destroy 处理器 */
function createAgentDestroyHandler(): IpcChannel<SessionScopedArgs, void> {
  return createIpcChannel<SessionScopedArgs, void>(
    "agent:destroy",
    (_event: IpcMainInvokeEvent, args: SessionScopedArgs) => {
      const manager = getAgentManager();
      manager.destroy(args.sessionId);
    },
  );
}

/** 创建 agent:approval-decide 处理器 — 渲染端写回 ApprovalDialog 的结果 */
function createApprovalDecideHandler(): IpcChannel<
  ApprovalDecisionArgs,
  { handled: boolean }
> {
  return createIpcChannel<ApprovalDecisionArgs, { handled: boolean }>(
    "agent:approval-decide",
    (_event: IpcMainInvokeEvent, args: ApprovalDecisionArgs) => {
      const manager = getAgentManager();
      const handled = manager.getApproval().decide(args.requestId, args.decision);
      return { handled };
    },
  );
}

/**
 * 创建 agent:approval-list 处理器 — 列出当前挂起的审批请求。
 * 新窗口打开或对话框重挂载时用来一次性补齐已有的待决审批。
 */
function createApprovalListHandler(): IpcChannel<void, ApprovalRequestPayload[]> {
  return createIpcChannel<void, ApprovalRequestPayload[]>(
    "agent:approval-list",
    (_event: IpcMainInvokeEvent) => {
      const manager = getAgentManager();
      return manager.getApproval().inspect();
    },
  );
}

/** 获取所有 agent 相关的 IPC 处理器 */
export function getAgentIpcHandlers(): AnyIpcChannel[] {
  return [
    createAgentCreateHandler(),
    createAgentSendMessageHandler(),
    createAgentResumeHandler(),
    createAgentGetStatusHandler(),
    createAgentGetStateHandler(),
    createAgentDestroyHandler(),
    createApprovalDecideHandler(),
    createApprovalListHandler(),
  ];
}
