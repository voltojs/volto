/**
 * Agent Wiring
 * 负责组装 agent 的所有依赖项
 */

import * as os from "node:os";
import { createAgent, DEFAULT_SESSION_SECRET_ENV_PATTERNS } from "@voltojs/sdk";
import type { ApprovalGate, EventSink, Message, PermissionConfig } from "@voltojs/core";
import { createPiAiModelPort } from "@voltojs/provider-pi-ai";
import {
  createNodeFileSystem,
  createNodeShell,
  createNodeNetwork,
  createNodeScheduler,
  createSandboxedFileSystem,
} from "@voltojs/runtime-node";
import type { SandboxConfig } from "@voltojs/runtime-node";
import { getStore } from "../store/index.js";
import type { StoreSchema } from "../store/schema.js";

/** Agent 配置选项 */
export interface AgentWiringOptions {
  /** 事件接收器 */
  eventSink: EventSink;
  /**
   * 人机确认网关 — 当 permissionConfig 产生 "ask" 决策时由内核回调。
   * 缺失时 SDK 会 fallback 到 auto-allow，等价于关闭审批；为了让 "ask"
   * 模式真正生效，本应用应当总是注入一个真实的 gate。
   */
  approvalGate?: ApprovalGate;
  /** 工作目录 */
  cwd?: string;
  /** OpenAI 兼容服务的 API Key（由调用方按会话绑定的供应商解析后传入） */
  apiKey: string | null;
  /** Custom baseURL; null/undefined falls back to the default hardcoded below in this file (provider-pi-ai itself does no default-URL fallback) */
  baseURL: string | null;
  /** 实际发给 API 的模型代码 */
  modelName: string;
  /** 该会话此前的历史消息（用于重建时恢复上下文），无历史则传空数组 */
  initialMessages: Message[];
}

/**
 * 创建 Agent 实例
 * 基于调用方传入的（已按会话解析好的）模型配置组装 agent；
 * permissionMode 仍然是全局设置，从 store 读取。
 */
export function createAgentInstance(options: AgentWiringOptions) {
  const {
    eventSink,
    approvalGate,
    cwd = process.cwd(),
    apiKey,
    baseURL,
    modelName,
    initialMessages,
  } = options;
  const store = getStore();

  const permissionMode = (store.get("permissionMode") as StoreSchema["permissionMode"]) ?? "auto";

  // 验证 API Key / 模型名称——调用方（agent-manager）应已从 providers 列表
  // 解析出具体值；这里仍然兜底校验，避免传空值静默进入 provider 请求。
  if (!apiKey) {
    throw new Error("API Key not configured. Please select a model with a valid provider.");
  }
  if (!modelName) {
    throw new Error("Model not configured. Please select a model in the chat page.");
  }

  // 创建核心适配器
  const fs = createNodeFileSystem({ root: cwd });
  const shell = createNodeShell({ defaultCwd: cwd });
  const network = createNodeNetwork();
  const modelPort = createPiAiModelPort({
    providers: [
      {
        kind: "custom",
        id: "default",
        // provider-pi-ai does no default-URL fallback of its own; this
        // wiring layer supplies the same default provider-openai used to.
        baseURL: baseURL ?? "https://api.openai.com",
        apiKey,
        models: [{ code: modelName }],
      },
    ],
    defaultProviderId: "default",
    defaultModel: modelName,
  });

  // 创建调度器
  const clock = { now: () => Date.now() };
  const scheduler = createNodeScheduler({ clock });

  // Permission is two orthogonal knobs: the sandbox boundary and the approval
  // policy. The three desktop tiers each bundle a pair.
  //   - "auto" → full access, never prompts (matches its "所有工具调用直接执行" copy)
  //   - "ask"  → workspace-write + ask: WRITE_HIGH and IRREVERSIBLE both reach
  //              the ApprovalDialog, which is what this tier exists for
  //   - "deny" → read-only: reads pass, every write is refused (matches its
  //              "只读模式" copy). The old behaviour also denied reads, leaving
  //              an agent that could do nothing at all.
  const permissionConfig: PermissionConfig =
    permissionMode === "auto"
      ? { sandbox: "danger-full-access", approval: "never" }
      : permissionMode === "deny"
        ? { sandbox: "read-only", approval: "never" }
        : { sandbox: "workspace-write", approval: "ask" };

  // One sandbox knob drives every sandboxed surface: the SDK wraps the shell
  // port AND builds the persistent-session spawner from this single config.
  // Without it the default (persistent-session) bash path ran unconfined
  // under the "ask" and "deny" tiers while permissionConfig claimed
  // confinement — the same wiring gap the gateway had. "auto" keeps
  // null: danger-full-access confines nothing by definition.
  const sandboxConfig: SandboxConfig | null =
    permissionMode === "auto"
      ? null
      : {
          mode: permissionMode === "deny" ? "read-only" : "workspace-write",
          writableRoots: [cwd, "/tmp", os.tmpdir()],
          readOnlyOverlays: [],
          network: { enabled: true },
          strippedEnvPatterns: [...DEFAULT_SESSION_SECRET_ENV_PATTERNS],
        };
  const sandboxedFs = sandboxConfig
    ? createSandboxedFileSystem(fs, sandboxConfig, { root: cwd })
    : fs;

  // 创建 agent
  const agent = createAgent({
    modelPort,
    model: modelName,
    // Anchors the persistent bash session's initial cwd at the workspace —
    // without it the session spawns at the Electron process cwd.
    cwd,
    fs: sandboxedFs,
    shell,
    network,
    eventSink,
    scheduler,
    permissionConfig,
    sandboxConfig: sandboxConfig ?? undefined,
    approvalGate,
    // ask_user reuses the same approvalGate: the renderer's ApprovalDialog
    // already displays any PendingToolCall's name/args/riskTier and writes
    // back allow/deny, which also covers ask_user (name: "ask_user",
    // input: { question }, riskTier: READ_ONLY) — the user sees the
    // question's JSON payload and decides allow/deny, which the tool then
    // maps to "用户回答：yes"/"用户未回答此问题". The SDK defaults
    // askUserGate to auto-allow, which would silently answer "yes" with no
    // human involved; this must be overridden explicitly.
    askUserGate: approvalGate,
    initialMessages,
  });

  return agent;
}
