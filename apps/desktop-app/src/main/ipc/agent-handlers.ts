/**
 * Agent 相关 IPC 处理器
 * 提供 agent 的消息发送、流式输出、会话管理等功能
 */

import { type IpcMainInvokeEvent } from "electron";
import { getAgentManager } from "../agent/agent-manager.js";
import { createIpcChannel, type IpcChannel } from "./handlers.js";

/** 发送消息请求参数 */
export interface SendMessageArgs {
  message: string;
}

/** 流式消息请求参数 */
export interface StreamMessageArgs {
  message: string;
}

/** 恢复会话请求参数 */
export interface ResumeSessionArgs {
  sessionId: string;
  decision: "allow" | "deny";
}

/** 创建 agent:create 处理器 */
function createAgentCreateHandler(): IpcChannel<void, { success: boolean; error?: string }> {
  return createIpcChannel<void, { success: boolean; error?: string }>(
    "agent:create",
    async (_event: IpcMainInvokeEvent) => {
      try {
        const manager = getAgentManager();
        manager.create();
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
        await manager.run(args.message);
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
        await manager.resume(args.sessionId, args.decision);
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
function createAgentGetStatusHandler(): IpcChannel<void, string> {
  return createIpcChannel<void, string>(
    "agent:get-status",
    (_event: IpcMainInvokeEvent) => {
      const manager = getAgentManager();
      return manager.getStatus();
    },
  );
}

/** 创建 agent:get-state 处理器 */
function createAgentGetStateHandler(): IpcChannel<void, unknown> {
  return createIpcChannel<void, unknown>(
    "agent:get-state",
    (_event: IpcMainInvokeEvent) => {
      const manager = getAgentManager();
      return manager.getState();
    },
  );
}

/** 创建 agent:destroy 处理器 */
function createAgentDestroyHandler(): IpcChannel<void, void> {
  return createIpcChannel<void, void>(
    "agent:destroy",
    (_event: IpcMainInvokeEvent) => {
      const manager = getAgentManager();
      manager.destroy();
    },
  );
}

/** 获取所有 agent 相关的 IPC 处理器 */
export function getAgentIpcHandlers(): IpcChannel[] {
  return [
    createAgentCreateHandler(),
    createAgentSendMessageHandler(),
    createAgentResumeHandler(),
    createAgentGetStatusHandler(),
    createAgentGetStateHandler(),
    createAgentDestroyHandler(),
  ];
}
