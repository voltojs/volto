---
title: 事件流与界面
type: guide
source:
  - packages/core/src/ports.ts
  - packages/runtimes/node/src/runner.ts
  - apps/headless-server/src/event-sinks.ts
  - packages/sdk/src/sse
generated: false
verified: 2026-11-11
---

# 事件流与界面

> 读完你会：能把内核事件接到自己的界面上，并知道哪些事件是稳定契约、哪些只是透传。

## 传输形状

内核只认一个接口：

```ts
interface EventSink {
  emit(event: { type: string; data: Record<string, unknown> }): void;
}
```

`type` 是字符串，`data` 是自由形状。**这意味着事件目录是约定，不是类型系统保证的**——所以下面区分「稳定」与「透传」很重要。

官方网关把它变成 SSE：

```text
data: {"type":"text_delta","data":{"text":"你"}}

data: {"type":"tool_result","data":{"toolCallId":"…","isError":false,"modelContent":"…"}}
```

`@volto/sdk/sse` 里有带具名帧与单调 id 的客户端，支持断线重连。

## 稳定事件（建议你的界面依赖这些）

| 事件 | 关键字段 | 用途 |
| --- | --- | --- |
| `text_delta` | `text` | 正文增量，逐字渲染 |
| `reasoning_delta` | `text` | 推理增量（可折叠显示） |
| `tool_use_start` / `tool_use_delta` | `toolCallId` / `toolName` / 参数增量 | 工具调用开始与参数流 |
| `tool_result` | `toolCallId`、`isError`、`modelContent`、`displayMetadata` | 工具结束；`displayMetadata` 是给界面的（diff、耗时） |
| `usage` | token 用量 | 用量与花费显示 |
| `turn_start` / `turn_end` | `reason`：`done` / `error` / `cancelled` / `budget_exceeded` | 一轮的边界 |
| `approval_asked` | 待审批调用的信息 | 弹审批卡 |
| `approval_decision` | 决定与原因 | 收起卡片、记审计 |
| `ask_user` | 问题文本 | 弹出提问 |
| `model_error` | `error`、`retriable?` | 展示可读错误，决定是否重试 |
| `compaction_applied` | 压缩前后规模 | 提示「上下文已压缩」 |
| `budget_exceeded` | 触顶的类型 | 说明为什么停下 |
| `background_task_completed` | 任务 id 与结果摘要 | 后台任务完成提醒 |
| `steering_queued` / `steering_delivered` | 排队消息 | 输入框里的排队态 |

其余事件（`hook_error`、`spill_failed`、`tokenizer_calibration`、`loop_reminder` 等）是诊断用的**透传**：可以只记日志、不渲染。随着实现演进而增减，别把它们当契约。

## 三条使用原则

1. **事件不是状态真相。** 需要「当前是什么状态」时读 `getState()` 或重新拉取会话详情；事件流只保证「发生过什么」，断线期间的事件不会补发。
2. **不要从事件推导业务结论。** 例如「这一轮成功了」看 `turn_end.reason`，不要去数 `tool_result` 的数量。
3. **渲染要能容忍未知事件。** 遇到不认识的 `type` 就忽略，否则内核加一个诊断事件就能让你的界面白屏。

## 排序与去重

- 同一会话内事件有序；跨会话不保证。
- 重连后建议从持久层重新拉一次会话，再用新事件增量合并——而不是假设事件流是完整日志。
- 持久层（转录）才是完整记录，事件流是它的实时投影。

## 出问题怎么办

- **界面卡在「生成中」** → 没收到 `turn_end`；检查 SSE 是否断线，以及你的消费循环是否在异常时还能收到结束事件。
- **工具卡片不消失** → `tool_result` 的 `toolCallId` 与 `tool_use_start` 对不上（常见原因是自己重排了事件）。
- **刷新后消息重复** → 重连合并时没按消息 id 去重。