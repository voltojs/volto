/**
 * Agent Wiring
 * 负责组装 agent 的所有依赖项
 * 参考 reference-cli/src/main.ts
 */

import { createAgent } from "@volto/sdk";
import { createDefaultPermissionConfig } from "@volto/core";
import type { ApprovalGate, EventSink, Message } from "@volto/core";
import { createPiAiModelPort } from "@volto/provider-pi-ai";
import {
  createNodeFileSystem,
  createNodeShell,
  createNodeNetwork,
  createNodeScheduler,
} from "@volto/runtime-node";
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

  // 权限配置 — 把 store 里的 "auto" / "ask" / "deny" 显式映射到 core 的
  // PermissionConfig。
  //
  // 这里有两个 core 侧术语容易混淆：
  //   - core 的 `mode` 字段只接受 "default" / "plan" / "auto-accept"
  //   - "plan" **不是**"询问模式"，而是"只读模式"：READ_ONLY → allow，所有写 → deny
  //   - "auto-accept" 是"自动接受"：除 IRREVERSIBLE 询问外全部 allow
  //   - tier-default 才是真正实现"询问"的地方：WRITE_HIGH 默认就是 "ask"
  //
  // 因此本应用三种 mode 的映射：
  //   - "auto" → mode = "auto-accept"（全部放行）
  //   - "ask"  → mode 保持 "default"，让 tier defaults 生效，IRREVERSIBLE 降为
  //              "ask" 让不可逆操作也能由用户审批，而不是直接拒绝
  //   - "deny" → mode 保持 "default"，全部 tier 一律 "deny"
  //
  // 历史教训：曾经把 "ask" 错映射到 "plan"，导致开箱后 WRITE_HIGH/IRREVERSIBLE
  // 一律静默 deny、ApprovalDialog 永远不弹——务必不要再改回去。
  const permissionConfig = createDefaultPermissionConfig();
  switch (permissionMode) {
    case "auto":
      permissionConfig.mode = "auto-accept";
      break;
    case "ask":
      // 保持 mode 为 undefined（即 "default"），让 tier defaults 决定：
      //   READ_ONLY → allow / WRITE_LOW → allow / WRITE_HIGH → ask (default)
      // 把默认的 IRREVERSIBLE: "deny" 改为 "ask"，让真正高风险也能由用户决定
      permissionConfig.defaults = {
        ...permissionConfig.defaults,
        IRREVERSIBLE: "ask",
      };
      break;
    case "deny":
      // 全部 tier 一律 deny；mode 保持 "default" 以便 rules/overrides 生效优先级
      permissionConfig.defaults = {
        READ_ONLY: "deny",
        WRITE_LOW: "deny",
        WRITE_HIGH: "deny",
        IRREVERSIBLE: "deny",
      };
      break;
    default: {
      // 永远不应到达——schema 已经把 permissionMode 收紧到上述三种之一。
      // 出现意外值时 fail-closed 到"询问"（保持 default + IRREVERSIBLE 升 ask）
      const _exhaustive: never = permissionMode;
      void _exhaustive;
      permissionConfig.defaults = {
        ...permissionConfig.defaults,
        IRREVERSIBLE: "ask",
      };
    }
  }

  // 创建 agent
  const agent = createAgent({
    modelPort,
    model: modelName,
    fs,
    shell,
    network,
    eventSink,
    scheduler,
    permissionConfig,
    approvalGate,
    initialMessages,
  });

  return agent;
}
