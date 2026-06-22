/**
 * Agent Wiring
 * 负责组装 agent 的所有依赖项
 * 参考 reference-cli/src/main.ts
 */

import { createAgent } from "@volto/sdk";
import { createDefaultPermissionConfig } from "@volto/core";
import type { EventSink } from "@volto/core";
import { createOpenAIModelPort } from "@volto/provider-openai";
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
  /** 工作目录 */
  cwd?: string;
}

/**
 * 创建 Agent 实例
 * 基于 store 中的配置组装 agent
 */
export function createAgentInstance(options: AgentWiringOptions) {
  const { eventSink, cwd = process.cwd() } = options;
  const store = getStore();

  // 从 store 读取配置
  const apiKey = store.get("apiKey") as string | null;
  const modelName = (store.get("modelName") as string) ?? "gpt-4";
  const permissionMode = (store.get("permissionMode") as StoreSchema["permissionMode"]) ?? "auto";

  // 验证 API Key
  if (!apiKey) {
    throw new Error("API Key not configured. Please set it in Settings.");
  }

  // 创建核心适配器
  const fs = createNodeFileSystem({ root: cwd });
  const shell = createNodeShell({ defaultCwd: cwd });
  const network = createNodeNetwork();
  const modelPort = createOpenAIModelPort({
    apiKey,
    defaultModel: modelName,
  });

  // 创建调度器
  const clock = { now: () => Date.now() };
  const scheduler = createNodeScheduler({ clock });

  // 权限配置 — 把 store 里的 "auto" / "ask" / "deny" 显式映射到 core 的
  // PermissionConfig。core 的 mode 字段只接受 "default" / "plan" / "auto-accept"，
  // 没有 "deny" 这种 mode，因此 "deny" 必须通过把 tier defaults 全部改成 deny 来实现，
  // 否则会静默退化成 "auto-accept" 这种安全级 bug。
  const permissionConfig = createDefaultPermissionConfig();
  switch (permissionMode) {
    case "auto":
      permissionConfig.mode = "auto-accept";
      break;
    case "ask":
      permissionConfig.mode = "plan";
      break;
    case "deny":
      // 全部 tier 一律 deny；mode 保持 "default" 以便 rules/overrides 生效优先级
      permissionConfig.mode = "default";
      permissionConfig.defaults = {
        READ_ONLY: "deny",
        WRITE_LOW: "deny",
        WRITE_HIGH: "deny",
        IRREVERSIBLE: "deny",
      };
      break;
    default: {
      // 永远不应到达——schema 已经把 permissionMode 收紧到上述三种之一。
      // 出现意外值时 fail-closed 到 "ask"（plan mode）。
      const _exhaustive: never = permissionMode;
      void _exhaustive;
      permissionConfig.mode = "plan";
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
  });

  return agent;
}
