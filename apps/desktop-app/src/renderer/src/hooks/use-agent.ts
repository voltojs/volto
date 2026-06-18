/**
 * use-agent.ts
 * 提供 Agent 操作的 React hook
 */

import { useState, useCallback } from "react";

/** Agent 状态 */
export type AgentStatus = "idle" | "running" | "streaming" | "error";

/** Agent 操作结果 */
export interface AgentResult {
  success: boolean;
  error?: string;
}

/** Electron API 类型声明 */
interface ElectronAPI {
  agent: {
    create: () => Promise<AgentResult>;
    sendMessage: (message: string) => Promise<AgentResult>;
    resume: (sessionId: string, decision: "allow" | "deny") => Promise<AgentResult>;
    getStatus: () => Promise<AgentStatus>;
    getState: () => Promise<unknown>;
    destroy: () => Promise<void>;
    onEvent: (callback: (event: unknown) => void) => () => void;
  };
}

/** 扩展 Window 接口 */
declare global {
  interface Window {
    electronAPI: ElectronAPI;
  }
}

/**
 * useAgent hook
 * 提供 agent 的创建、消息发送、状态管理等功能
 */
export function useAgent() {
  const [status, setStatus] = useState<AgentStatus>("idle");
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  /** 获取 electron API */
  const getAPI = useCallback(() => window.electronAPI.agent, []);

  /** 创建 agent */
  const create = useCallback(async (): Promise<AgentResult> => {
    setIsLoading(true);
    setError(null);
    try {
      const result = await getAPI().create();
      if (!result.success) {
        setError(result.error ?? "Failed to create agent");
      }
      return result;
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      setError(errorMessage);
      return { success: false, error: errorMessage };
    } finally {
      setIsLoading(false);
    }
  }, [getAPI]);

  /** 发送消息 */
  const sendMessage = useCallback(async (message: string): Promise<AgentResult> => {
    setIsLoading(true);
    setError(null);
    try {
      const result = await getAPI().sendMessage(message);
      if (!result.success) {
        setError(result.error ?? "Failed to send message");
      }
      return result;
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      setError(errorMessage);
      return { success: false, error: errorMessage };
    } finally {
      setIsLoading(false);
    }
  }, [getAPI]);

  /** 恢复会话 */
  const resume = useCallback(async (
    sessionId: string,
    decision: "allow" | "deny",
  ): Promise<AgentResult> => {
    setIsLoading(true);
    setError(null);
    try {
      const result = await getAPI().resume(sessionId, decision);
      if (!result.success) {
        setError(result.error ?? "Failed to resume session");
      }
      return result;
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      setError(errorMessage);
      return { success: false, error: errorMessage };
    } finally {
      setIsLoading(false);
    }
  }, [getAPI]);

  /** 获取状态 */
  const getStatus = useCallback(async (): Promise<AgentStatus> => {
    try {
      const currentStatus = await getAPI().getStatus();
      setStatus(currentStatus);
      return currentStatus;
    } catch {
      return "error";
    }
  }, [getAPI]);

  /** 销毁 agent */
  const destroy = useCallback(async (): Promise<void> => {
    try {
      await getAPI().destroy();
      setStatus("idle");
      setError(null);
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      setError(errorMessage);
    }
  }, [getAPI]);

  /** 清除错误 */
  const clearError = useCallback(() => {
    setError(null);
  }, []);

  return {
    status,
    isLoading,
    error,
    create,
    sendMessage,
    resume,
    getStatus,
    destroy,
    clearError,
  };
}
