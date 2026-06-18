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

  // 权限配置
  const permissionConfig = createDefaultPermissionConfig();
  permissionConfig.mode = permissionMode === "ask" ? "plan" : "auto-accept";

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
