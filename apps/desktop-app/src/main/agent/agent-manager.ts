/**
 * Agent Manager
 * 负责 Agent 生命周期管理：create, run, stream, destroy
 * 按 sessionId 路由——每个 UI 会话拥有独立的 Agent 实例与独立的对话历史，
 * 互不影响；模型/供应商切换只需重建对应 session 的实例。
 * approval gate 是全 app 共享的一份（按 requestId 而非 session 追踪挂起
 * 请求），不随单个 session 的创建/销毁而失效。
 */

import type { AgentInstance } from "@volto/sdk";
import type { EventSink, Message } from "@volto/core";
import { createAgentInstance } from "./wiring.js";
import { createApprovalGate } from "./approval-gate.js";
import { resolveModelBinding, persistedMessagesToInitialMessages } from "./session-history.js";
import { getStore } from "../store/index.js";
import type { ProviderConfig, SessionMeta, PersistedMessage } from "../store/schema.js";

/** Agent 状态 */
export type AgentStatus = "idle" | "running" | "streaming" | "error";

/**
 * Agent Manager
 * 管理多个 session 的 Agent 实例生命周期
 */
export class AgentManager {
  private agents: Map<string, AgentInstance> = new Map();
  private statuses: Map<string, AgentStatus> = new Map();
  private eventSink: EventSink;
  private cwd: string;
  /** approval gate 句柄（gateFor / decide / dispose / inspect），全 app 共享一份 */
  private approval: ReturnType<typeof createApprovalGate>;

  constructor(eventSink: EventSink, cwd?: string) {
    this.eventSink = eventSink;
    this.cwd = cwd ?? process.cwd();
    this.approval = createApprovalGate();
  }

  /** 暴露 approval 句柄给 IPC handler 用（decide/inspect；dispose 不外暴） */
  getApproval(): Pick<ReturnType<typeof createApprovalGate>, "gateFor" | "decide" | "inspect"> {
    return this.approval;
  }

  /** 获取某个 session 的状态 */
  getStatus(sessionId: string): AgentStatus {
    return this.statuses.get(sessionId) ?? "idle";
  }

  private setStatus(sessionId: string, status: AgentStatus): void {
    this.statuses.set(sessionId, status);
  }

  /** 把内部错误归一化为 EventSink 上的 `error` 事件，带上 sessionId */
  private emitError(source: string, error: unknown, sessionId: string): void {
    const message = error instanceof Error ? error.message : String(error);
    try {
      this.eventSink.emit({
        type: "error",
        data: { error: message, source, sessionId },
      });
    } catch (sinkErr) {
      console.error("[agent-manager] eventSink.emit failed:", sinkErr);
    }
  }

  /** 给某个 session 的每一条事件打上 sessionId，供渲染端按会话路由 */
  private sessionEventSink(sessionId: string): EventSink {
    return {
      emit: (event) => {
        this.eventSink.emit({
          ...event,
          data: { ...event.data, sessionId },
        });
      },
    };
  }

  /**
   * 创建（或重建）某个 session 的 Agent 实例。
   * 从 electron-store 里按该 session 绑定的 providerId/modelId 解析出具体的
   * apiKey/baseURL/模型代码；找不到（未绑定或已被删除）则抛出明确错误。
   * 同时把该 session 已持久化的历史消息转换成初始对话状态，让切换/重建后
   * 上下文不丢。
   */
  create(sessionId: string): AgentInstance {
    if (this.agents.has(sessionId)) {
      this.agents.delete(sessionId);
    }

    try {
      const store = getStore();
      const sessions = (store.get("sessions") as SessionMeta[] | undefined) ?? [];
      const meta = sessions.find((s) => s.id === sessionId);
      const providers = (store.get("providers") as ProviderConfig[] | undefined) ?? [];
      const binding = resolveModelBinding(providers, meta?.providerId, meta?.modelId);
      if (!binding) {
        throw new Error(
          "Model not configured or has been deleted for this session. Please select a model.",
        );
      }

      const sessionMessages =
        (store.get("sessionMessages") as Record<string, PersistedMessage[]> | undefined) ?? {};
      const persisted = sessionMessages[sessionId] ?? [];
      const initialMessages: Message[] = persistedMessagesToInitialMessages(persisted);

      const agent = createAgentInstance({
        eventSink: this.sessionEventSink(sessionId),
        approvalGate: this.approval.gateFor(sessionId),
        cwd: this.cwd,
        apiKey: binding.apiKey,
        baseURL: binding.baseURL,
        modelName: binding.modelCode,
        initialMessages,
      });
      this.agents.set(sessionId, agent);
      this.setStatus(sessionId, "idle");
      return agent;
    } catch (error) {
      this.setStatus(sessionId, "error");
      this.emitError("agent:create", error, sessionId);
      throw error;
    }
  }

  /** 获取某个 session 的 Agent 实例（不存在返回 null，不自动创建） */
  getAgent(sessionId: string): AgentInstance | null {
    return this.agents.get(sessionId) ?? null;
  }

  /** 运行 Agent（单次对话）；该 session 还没有实例时自动创建 */
  async run(sessionId: string, input: string): Promise<ReturnType<AgentInstance["run"]>> {
    let agent = this.agents.get(sessionId);
    if (!agent) {
      agent = this.create(sessionId);
    }

    this.setStatus(sessionId, "running");
    try {
      const result = await agent.run(input);
      if (this.agents.get(sessionId) === agent) {
        this.setStatus(sessionId, "idle");
      }
      return result;
    } catch (error) {
      if (this.agents.get(sessionId) === agent) {
        this.setStatus(sessionId, "error");
      }
      this.emitError("agent:run", error, sessionId);
      throw error;
    }
  }

  /** 流式运行 Agent；该 session 还没有实例时自动创建 */
  async *stream(
    sessionId: string,
    input: string,
  ): AsyncGenerator<{ type: string; data: Record<string, unknown> }> {
    let agent = this.agents.get(sessionId);
    if (!agent) {
      agent = this.create(sessionId);
    }

    this.setStatus(sessionId, "streaming");
    try {
      yield* agent.stream(input);
      if (this.agents.get(sessionId) === agent) {
        this.setStatus(sessionId, "idle");
      }
    } catch (error) {
      if (this.agents.get(sessionId) === agent) {
        this.setStatus(sessionId, "error");
      }
      this.emitError("agent:stream", error, sessionId);
      throw error;
    }
  }

  /**
   * 恢复 HITL 暂停的会话（跨进程重启后的罕见路径；日常审批走
   * agent:approval-decide，不经过这里）。
   * @param sessionId 聊天会话 id，用于定位应该在哪个 AgentInstance 上恢复
   * @param resumeId SDK 内部生成的 HITL 会话标识（与 sessionId 是两个概念）
   */
  async resume(
    sessionId: string,
    resumeId: string,
    decision: "allow" | "deny",
  ): Promise<ReturnType<AgentInstance["resume"]>> {
    const agent = this.agents.get(sessionId);
    if (!agent) {
      const err = new Error("Agent not created. Call create() first.");
      this.emitError("agent:resume", err, sessionId);
      throw err;
    }

    this.setStatus(sessionId, "running");
    try {
      const result = await agent.resume(resumeId, decision);
      this.setStatus(sessionId, "idle");
      return result;
    } catch (error) {
      this.setStatus(sessionId, "error");
      this.emitError("agent:resume", error, sessionId);
      throw error;
    }
  }

  /** 获取某个 session 的当前 state（没有实例返回 null） */
  getState(sessionId: string): ReturnType<AgentInstance["getState"]> | null {
    return this.agents.get(sessionId)?.getState() ?? null;
  }

  /**
   * 销毁某个 session 的 Agent 实例。
   * 必须 await agent.dispose()：实例持有长驻 bash 会话与后台进程，光从 Map
   * 里删掉只会让它们一直跑到整个 app 退出。
   * approval gate 是全 app 共享的，不随单个 session 销毁而 dispose——
   * 只有 disposeAll()（整个 app 退出）才会清空全部挂起审批。
   */
  async destroy(sessionId: string): Promise<void> {
    const agent = this.agents.get(sessionId);
    this.agents.delete(sessionId);
    this.statuses.delete(sessionId);
    await this.disposeAgent(agent, sessionId);
  }

  /** 销毁所有 session 的实例并 dispose 共享 approval gate（app 退出时用） */
  async disposeAll(): Promise<void> {
    const agents = [...this.agents.entries()];
    this.agents.clear();
    this.statuses.clear();
    await Promise.all(agents.map(([id, agent]) => this.disposeAgent(agent, id)));
    this.approval.dispose();
  }

  /**
   * 子进程回收是尽力而为：一个实例 dispose 失败不能阻断其余实例的回收，
   * 也不该把 app 退出流程炸掉，所以归一化成 EventSink 上的 error 事件。
   */
  private async disposeAgent(
    agent: AgentInstance | undefined,
    sessionId: string,
  ): Promise<void> {
    if (!agent) return;
    try {
      await agent.dispose();
    } catch (error) {
      this.emitError("agent:dispose", error, sessionId);
    }
  }
}

/** 全局 Agent Manager 单例（单例管理多个 session 的实例 Map，不是单一 agent 单例） */
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

/** 销毁 Agent Manager 单例（app 退出时调用） */
export async function destroyAgentManager(): Promise<void> {
  if (agentManagerInstance) {
    const manager = agentManagerInstance;
    agentManagerInstance = null;
    await manager.disposeAll();
  }
}
