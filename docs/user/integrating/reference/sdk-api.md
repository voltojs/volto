---
title: SDK 导读
type: reference
source:
  - packages/sdk/src/create-agent.ts
  - packages/sdk/src/index.ts
generated: false
verified: 2026-11-11
---

# SDK 导读

> 读完你会：知道 `createAgent` 的选项分几类、实例上有哪些方法、错误怎么到你手上。

先看 [把 agent 嵌进自己的宿主](../tutorial/01-embed-agent.md) 跑通一次，再回来查细节。导出清单见 [SDK 导出](./sdk-exports.md)。

## 生命周期

```
createAgent(options) → AgentInstance
  .run(input)      跑完一轮，返回最终状态
  .stream(input)   边跑边产出事件
  .steer(input)    向进行中的回合插话（不开启新回合）
  .resume(...)     带人工决策恢复挂起的执行
  .compactNow()    手动压缩一次上下文
  .getState()      读当前状态快照
  .dispose()       释放端口与子进程
```

**并发契约：一个实例同时只服务一轮。** 并发会话请各自 `createAgent()`。

## 选项分组

`createAgent` 的选项很多，但可以按「不传会怎样」分四类。

### 必填

| 选项 | 说明 |
| --- | --- |
| `modelPort` | 模型连接。见 [端口与默认实现](../guides/ports-and-defaults.md) |

### 决定它能不能干活

| 选项 | 不传时 |
| --- | --- |
| `fs` / `shell` / `network` | 对应工具从可见集里消失 |
| `approvalGate` | 需要审批的动作没有宿主可问 |
| `sandboxConfig` | 不做隔离 |
| `capabilities` | 只有默认能力集 |

### 决定它有多克制

| 选项 | 作用 |
| --- | --- |
| `permissionConfig` | `{ sandbox, approval }` 二元组；通常由预设档位生成 |
| `maxIterations` | 一轮最多几次「模型 → 工具」往返 |
| `tokenBudget` / `maxTokensPerTurn` | 上下文与单轮 token 上限 |
| `maxToolCalls` | 一轮工具调用总次数上限 |
| `maxCostTokens` / `maxDollarsPerTurn` | 花费上限（需要价格表） |
| `maxWallclockMs` | 一轮墙钟时间上限 |
| `maxLoopCount` / `maxLoopInterventions` | 检测模型原地打转并介入 |
| `selfCorrectionMax` | 让模型自我纠正的轮数 |
| `compaction` / `contextWindow` | 何时压缩、窗口多大 |

这些上限触发时不会抛异常：一轮会以「达到上限」结束，状态里带着原因。

### 决定它记得什么

| 选项 | 作用 |
| --- | --- |
| `sessionStore` | 会话状态持久化 |
| `chatStore` + `chatSessionId` + `chatMeta` | 对话记录持久化（可恢复） |
| `memoryStore` + `embedder` | 跨会话长期记忆 |
| `chatStore`（转录）+ `auditSink`（审计流水） | 对话记录与审计轨迹 |
| `planStore` | 计划文档存储 |
| `initialMessages` / `initialTurn` / `initialStep` | 从快照恢复时的种子值 |

### 定制它的行为

| 选项 | 作用 |
| --- | --- |
| `systemPrompt` | 系统提示；`resolveContextLayers` / `initialContextLayers` 追加指令层 |
| `tools` / `toolSources` / `plugins` | 追加或替换工具来源 |
| `toolVisibility: { scope, limit }` 覆盖默认推导；`capabilities` 收窄可见集 | 见 [工具契约](./tool-contract.md) 与 [工具装配与权限策略](../guides/tools-and-policy.md) |
| `agentSpecs` / `maxAgentDepth` | 子代理定义与嵌套深度 |
| `skillRegistry` | 技能目录 |
| `routingTiers` / `model` / `providerId` | 模型选择与分档 |
| `workflowReminder` / `resolveWorkspaceReminder` | 注入工作流模式、工作目录与分支提醒 |
| `hooks` / `policyEngine` | 生命周期钩子与策略判定 |

## 错误怎么到你手上

- **模型调用失败** → 归一化成 `ModelError` 输入回喂内核，不会抛给你；一轮可能继续或结束。
- **工具执行失败** → `{ isError: true }` 的 `ToolResult` 回喂模型，模型自己决定怎么补救。
- **宿主端口抛错** → 记为该工具的错误结果，同样不打断主循环。
- **`run()` / `stream()` 本身抛错** → 只发生在调用契约被破坏时（比如同一实例并发两轮）。

换句话说：**可恢复的错误都是数据，不是异常。** 这是为了让循环能自愈，也让宿主不必写一吨 try/catch。

## 订阅事件

`eventSink.emit(event)` 拿到的是 `{ type, data }`。至少要处理：

| 事件 | 什么时候 |
| --- | --- |
| `text_delta` | 模型吐字 |
| 工具开始 / 结束 | 调用前/后（含参数、结果、耗时） |
| 审批请求 | 需要宿主弹窗 |
| `turn_end` | 一轮结束，带结束原因 |

事件是给界面看的，**不要**把它当成状态真相——需要状态就读 `getState()`。