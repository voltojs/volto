/**
 * Agent Manager
 * 负责 Agent 生命周期管理：create, run, stream, destroy
 */

import type { AgentInstance } from "@volto/sdk";
import type { ApprovalGate, EventSink } from "@volto/core";
import { createAgentInstance } from "./wiring.js";
import { createApprovalGate, type ApprovalRequestPayload } from "./approval-gate.js";

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
  /** approval gate handle (gate / decide / dispose / inspect) */
  private approval: ReturnType<typeof createApprovalGate>;

  constructor(eventSink: EventSink, cwd?: string) {
    this.eventSink = eventSink;
    this.cwd = cwd ?? process.cwd();
    // ApprovalGate 在 Manager 生命周期内共享一份；create() 重新构造 agent 时复用同一个 gate，
    // 这样挂起的 approval 请求不会因为 agent 销毁丢表，但在 destroy() 时会被强制 deny。
    this.approval = createApprovalGate();
  }

  /** 暴露 approval gate 句柄给 IPC handler 用（decide / inspect） */
  getApproval(): { gate: ApprovalGate; decide: (id: string, d: "allow" | "deny") => boolean; inspect: () => ApprovalRequestPayload[] } {
    return this.approval;
  }

  /** 获取当前状态 */
  getStatus(): AgentStatus {
    return this.status;
  }

  /** 设置状态 */
  private setStatus(status: AgentStatus): void {
    this.status = status;
  }

  /**
   * 把内部错误归一化为 EventSink 上的 `error` 事件，转交给渲染端处理。
   * 这是 plan-execution-gate / AGENTS.md 的"错误不中断主循环"纪律在 app 层的体现：
   * 内部边界仍然可以向上 throw，但同时必须把错误以事件形式让 UI 拿到，
   * 不能只让错误悄悄落到 IPC 返回值的 `{success:false}` 里。
   */
  private emitError(source: string, error: unknown): void {
    const message = error instanceof Error ? error.message : String(error);
    try {
      this.eventSink.emit({
        type: "error",
        data: { error: message, source },
      });
    } catch (sinkErr) {
      // EventSink 自身报错绝不能反过来打断主循环，记日志即可
      console.error("[agent-manager] eventSink.emit failed:", sinkErr);
    }
  }

  /** 创建 Agent 实例 */
  create(): AgentInstance {
    if (this.agent) {
      this.destroy({ keepApproval: true });
    }

    try {
      this.agent = createAgentInstance({
        eventSink: this.eventSink,
        approvalGate: this.approval.gate,
        cwd: this.cwd,
      });
      this.setStatus("idle");
      return this.agent;
    } catch (error) {
      this.setStatus("error");
      this.emitError("agent:create", error);
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
      const err = new Error("Agent not created. Call create() first.");
      this.emitError("agent:run", err);
      throw err;
    }

    this.setStatus("running");
    try {
      const result = await this.agent.run(input);
      this.setStatus("idle");
      return result;
    } catch (error) {
      this.setStatus("error");
      this.emitError("agent:run", error);
      throw error;
    }
  }

  /** 流式运行 Agent */
  async *stream(
    input: string,
  ): AsyncGenerator<{ type: string; data: Record<string, unknown> }> {
    if (!this.agent) {
      const err = new Error("Agent not created. Call create() first.");
      this.emitError("agent:stream", err);
      throw err;
    }

    this.setStatus("streaming");
    try {
      yield* this.agent.stream(input);
      this.setStatus("idle");
    } catch (error) {
      this.setStatus("error");
      this.emitError("agent:stream", error);
      throw error;
    }
  }

  /** 恢复 HITL 暂停的会话 */
  async resume(
    sessionId: string,
    decision: "allow" | "deny",
  ): Promise<ReturnType<AgentInstance["resume"]>> {
    if (!this.agent) {
      const err = new Error("Agent not created. Call create() first.");
      this.emitError("agent:resume", err);
      throw err;
    }

    this.setStatus("running");
    try {
      const result = await this.agent.resume(sessionId, decision);
      this.setStatus("idle");
      return result;
    } catch (error) {
      this.setStatus("error");
      this.emitError("agent:resume", error);
      throw error;
    }
  }

  /** 获取当前状态 */
  getState(): ReturnType<AgentInstance["getState"]> | null {
    return this.agent?.getState() ?? null;
  }

  /**
   * 销毁 Agent 实例
   * @param opts.keepApproval 内部 create() 重建时使用，避免清掉共享 gate 的挂起请求
   */
  destroy(opts: { keepApproval?: boolean } = {}): void {
    this.agent = null;
    this.setStatus("idle");
    if (!opts.keepApproval) {
      // 销毁单例时把挂起请求全部 deny，避免渲染端的对话框永远空挂
      this.approval.dispose();
    }
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
