/**
 * Agent Manager
 * 负责 Agent 生命周期管理：create, run, stream, destroy
 */

import type { AgentInstance } from "@volto/sdk";
import type { EventSink } from "@volto/core";
import { createAgentInstance } from "./wiring.js";

/** Agent 状态 */
export type AgentStatus = "idle" | "running" | "streaming" | "error";

/** Agent Manager 事件 */
export interface AgentManagerEvents {
  /** Agent 状态变化 */
  onStatusChange: (status: AgentStatus) => void;
  /** Agent 错误 */
  onError: (error: Error) => void;
}

/**
 * Agent Manager
 * 管理 Agent 实例的生命周期
 */
export class AgentManager {
  private agent: AgentInstance | null = null;
  private status: AgentStatus = "idle";
  private eventSink: EventSink;
  private cwd: string;

  constructor(eventSink: EventSink, cwd?: string) {
    this.eventSink = eventSink;
    this.cwd = cwd ?? process.cwd();
  }

  /** 获取当前状态 */
  getStatus(): AgentStatus {
    return this.status;
  }

  /** 设置状态 */
  private setStatus(status: AgentStatus): void {
    this.status = status;
  }

  /** 创建 Agent 实例 */
  create(): AgentInstance {
    if (this.agent) {
      this.destroy();
    }

    try {
      this.agent = createAgentInstance({
        eventSink: this.eventSink,
        cwd: this.cwd,
      });
      this.setStatus("idle");
      console.log("Agent created");
      return this.agent;
    } catch (error) {
      this.setStatus("error");
      throw error;
    }
  }

  /** 获取 Agent 实例 */
  getAgent(): AgentInstance | null {
    return this.agent;
  }

  /** 运行 Agent（单次对话） */
  async run(input: string): Promise<ReturnType<AgentInstance["run"]>> {
    if (!this.agent) {
      throw new Error("Agent not created. Call create() first.");
    }

    this.setStatus("running");
    try {
      const result = await this.agent.run(input);
      this.setStatus("idle");
      return result;
    } catch (error) {
      this.setStatus("error");
      throw error;
    }
  }

  /** 流式运行 Agent */
  async *stream(
    input: string,
  ): AsyncGenerator<{ type: string; data: Record<string, unknown> }> {
    if (!this.agent) {
      throw new Error("Agent not created. Call create() first.");
    }

    this.setStatus("streaming");
    try {
      yield* this.agent.stream(input);
      this.setStatus("idle");
    } catch (error) {
      this.setStatus("error");
      throw error;
    }
  }

  /** 恢复 HITL 暂停的会话 */
  async resume(
    sessionId: string,
    decision: "allow" | "deny",
  ): Promise<ReturnType<AgentInstance["resume"]>> {
    if (!this.agent) {
      throw new Error("Agent not created. Call create() first.");
    }

    this.setStatus("running");
    try {
      const result = await this.agent.resume(sessionId, decision);
      this.setStatus("idle");
      return result;
    } catch (error) {
      this.setStatus("error");
      throw error;
    }
  }

  /** 获取当前状态 */
  getState(): ReturnType<AgentInstance["getState"]> | null {
    return this.agent?.getState() ?? null;
  }

  /** 销毁 Agent 实例 */
  destroy(): void {
    this.agent = null;
    this.setStatus("idle");
    console.log("Agent destroyed");
  }
}

/** 全局 Agent Manager 单例 */
let agentManagerInstance: AgentManager | null = null;

/** 获取 Agent Manager 单例 */
export function getAgentManager(eventSink?: EventSink, cwd?: string): AgentManager {
  if (!agentManagerInstance && eventSink) {
    agentManagerInstance = new AgentManager(eventSink, cwd);
  }
  if (!agentManagerInstance) {
    throw new Error("AgentManager not initialized. Provide eventSink on first call.");
  }
  return agentManagerInstance;
}

/** 销毁 Agent Manager 单例 */
export function destroyAgentManager(): void {
  if (agentManagerInstance) {
    agentManagerInstance.destroy();
    agentManagerInstance = null;
  }
}
