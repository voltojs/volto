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

> 读完你会：能把内核事件接到自己的界面上，并知道哪些事件可以依赖、断线之后怎么接上。

## 传输形状

内核只认一个接口：

```text
interface EventSink {
  emit(event: { type: string; data: Record<string, unknown> }): void;
}
```

`type` 是字符串，`data` 是自由形状。官方网关把它变成 SSE：

```text
data: {"type":"tool_result","data":{"callId":"…","isError":false,"content":"…"}}

```

`@volto/sdk/sse` 里的客户端用带 id 的具名帧、支持 `Last-Event-ID` 续传；网关的 `/events` 也读这个头补发断线期间的事件。

## 两类事件

### 只在连接上出现的增量（不落盘）

| 事件 | 字段 | 说明 |
| --- | --- | --- |
| `text_delta` | `text` | 正文增量，逐字渲染 |
| `reasoning_delta` | `text` | 推理增量（可折叠显示） |
| `tool_use_delta` | 首条带 `toolCallId` / `toolCallName`，后续带参数增量 | 工具调用的参数流 |

它们不写进转录：刷新页面后它们就没了，靠下表的转录事件重建界面。

### 转录事件（落盘，同时也流式发出）

| 事件 | 关键字段 | 用途 |
| --- | --- | --- |
| `turn_start` / `turn_end` | `turn`；`turn_end.reason` = `done` / `error` / `cancelled` / `budget_exceeded` | 一轮的边界 |
| `model_call_start` / `assistant_message` | `assistant_message.content`、`stopReason`、**`usage`** | 一次模型调用；token 用量在这里，不在单独的事件里 |
| `tool_call` | `callId`、`name`、`input` | 工具调用已完整（参数收齐、即将执行） |
| `tool_result` | `callId`、`name?`、`content`、`isError?`、`displayMetadata?` | 工具结束；`content` 是字符串或内容块数组 |
| `approval_asked` / `approval_decision` | `callId`、`name`、`riskTier` | 弹审批卡 / 记录决定与原因 |
| `model_error` / `model_retry` | `error`、`retriable`；`attempt`、`delayMs` | 可读错误与自动重试 |
| `compaction` | `replacedCount`、`summaryText` | 上下文被压缩了 |
| `tool_results_pruned` | 被裁剪的条目 | 过大的工具结果被持久裁剪 |
| `context_reminder` | `kind`、`text` | 注入的提醒：工作目录/分支、权限边界、后台任务完成等 |
| `user_message` / `steering_*` | 内容 / id | 用户消息与排队消息的增删改 |
| `subagent_*` | `subagent_started` / `subagent_finished` / `subagent_tools_dropped` / `subagent_permission_downgraded` / `subagent_model_tier_unresolved` | 子代理生命周期 |
| `budget_exceeded` / `error` | `reason` / `message` | 为什么停下、为什么失败 |

**完整词表以 `packages/core/src/ports.ts` 的转录事件表为准**，`GET /sessions/:id/events` 能取到原始的落盘事件，和界面看到的是同一份。

### 子代理的验收判定

派发带了验收标准（`task` 的 `acceptance` 参数）时，两处携带同一份判定：

- `subagent_finished.verification` —— 可选字段；没写标准的派发与旧日志里缺席。
- `tool_result.displayMetadata.verification` —— `task` 的结果（后台任务则是 `task_output` 的结果）携带同一份判定，工具卡不用 join 事件就能渲染徽标。

```text
verification?: {
  status: "passed" | "failed" | "error";
  attempts: number;        // 子代理实际跑了几次，判定调用不计入
  failures: string[];      // 失败原因，最多 5 条
  verifierError?: string;  // 判定器自身为何没跑成
}
```

`status` 只用于展示与文案：`failed` 表示返工用尽仍未达标，对应的 `tool_result` 是 `isError: true`；`error` 表示判定器自身没跑成（超时 / 输出无法解析），不是实质失败，结果也不是错误。判断「这次派发是否失败」请读 `isError`（`tool_result` 或 `subagent_finished` 上都有），不要读 `status`。

事件里只有上面四个字段；`displayMetadata.verification` 与结果正文的信封还可能带 `retryHint`（修复建议）和 `usage`（判定调用的消耗，独立累计，不并入子代理自身用量）。

后台派发的 `subagent_finished` 在派遣回合关闭之后才到，判定会补盖到原派遣卡上；模型一直没调用 `task_output` 时，完成通知（`context_reminder`，`kind: "background_task"`）正文的第一行是 `[background task <taskId> finished]` 标题，`[verification: …]` 判定行紧随其后——解析判定不要只读第一行。

## 三条使用原则

1. **事件不是状态真相。** 需要「当前是什么状态」时读 `getState()` 或重新拉会话详情。事件流表达的是「发生过什么」。
2. **不要从事件推导业务结论。** 「这一轮成功了」看 `turn_end.reason`，不要去数 `tool_result` 的数量。
3. **渲染要能容忍未知事件。** 遇到不认识的 `type` 就忽略，否则内核加一个诊断事件就能让你的界面白屏。

## 断线与排序

- 同一会话内事件有序；跨会话不保证。
- 重连带 `Last-Event-ID` 会补上断线期间的事件；没有这个 id 就只能从当前时刻接着看，所以**页面首屏仍应从持久层拉一次**，再增量合并。
- 合并要按消息 / 调用 id 去重，而不是按到达顺序位置。

## 出问题怎么办

- **界面卡在「生成中」** → 没收到 `turn_end`；检查 SSE 是否断线，以及你的消费循环在异常时还能不能收到结束事件。
- **工具卡片不消失** → `tool_result.callId` 与 `tool_call.callId` 对不上（常见原因：自己重排了事件）。
- **刷新后消息重复** → 重连合并时没按 id 去重。
- **用量一直显示 0** → 用量不在独立事件里，要从 `assistant_message.usage` 取。