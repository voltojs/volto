/**
 * Session ↔ Agent 桥接的纯辅助函数：
 * - resolveModelBinding：按会话绑定的 providerId/modelId 在 providers 列表里
 *   查找具体的 apiKey/baseURL/模型代码。
 * - persistedMessagesToInitialMessages：把渲染端持久化的消息列表转换成
 *   @volto/sdk 可接受的历史消息种子（createAgent 的 initialMessages 选项）。
 *
 * 已知简化：只还原纯文本轮次（user / assistant 文本 / system），不重建
 * assistant 消息里的 tool_use / tool_result content block —— 持久化的
 * PersistedToolCall 结构不足以安全重建符合 provider API 要求的配对，
 * 错误重建可能导致请求被 400。UI 侧的历史消息展示不受影响（那是
 * chat-store 自己的数据，与这里的模型上下文重建是两回事）。
 */

import type { Message } from "@volto/core";
import type { ProviderConfig, PersistedMessage } from "../store/schema.js";

/** 解析出的模型绑定：某个 session 实际应该用哪个供应商的哪个模型 */
export interface ResolvedModelBinding {
  apiKey: string | null;
  baseURL: string | null;
  modelCode: string;
}

/**
 * 按 session 绑定的 providerId/modelId 在 providers 列表里查找具体配置。
 * providerId/modelId 缺失、或者对应的供应商/模型已被删除，都返回 null——
 * 调用方应把 null 视为"该 session 尚未正确绑定模型"，抛出明确错误而不是
 * 静默 fallback。
 */
export function resolveModelBinding(
  providers: ProviderConfig[],
  providerId: string | undefined,
  modelId: string | undefined,
): ResolvedModelBinding | null {
  if (!providerId || !modelId) return null;
  const provider = providers.find((p) => p.id === providerId);
  if (!provider) return null;
  const model = provider.models.find((m) => m.id === modelId);
  if (!model) return null;
  return { apiKey: provider.apiKey, baseURL: provider.baseURL, modelCode: model.code };
}

/**
 * 把渲染端持久化的消息列表转换成 SDK 的历史消息种子。
 * 空文本的 assistant 消息（比如纯工具调用、无文本内容）会被跳过，避免
 * 产生空 content block。
 */
export function persistedMessagesToInitialMessages(persisted: PersistedMessage[]): Message[] {
  const messages: Message[] = [];
  for (const msg of persisted) {
    if (msg.role === "user") {
      messages.push({ role: "user", content: msg.content });
    } else if (msg.role === "assistant") {
      if (!msg.content) continue;
      messages.push({
        role: "assistant",
        content: [{ type: "text", text: msg.content }],
        stopReason: "end_turn",
      });
    } else if (msg.role === "system") {
      messages.push({ role: "system", content: msg.content });
    }
  }
  return messages;
}
