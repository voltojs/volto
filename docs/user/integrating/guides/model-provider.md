---
title: 模型连接（ModelPort）
type: guide
source:
  - packages/core/src/ports.ts
  - packages/providers/openai/src/model-port.ts
  - packages/providers/anthropic/src/model-port.ts
  - packages/providers/pi-ai/src/model-port.ts
generated: false
verified: 2026-11-11
---

# 模型连接（ModelPort）

> 读完你会：能自己实现一个模型连接，或者判断现成适配器够不够用。

## 契约只有一个方法

```text
interface ModelPort {
  stream(req: ModelRequest): AsyncIterable<ModelEvent>;
  describeModel?(model: string): Promise<ResolvedModelInfo>;
}
```

- `stream` 必须**边收边吐**：一次调用返回一个异步迭代器，事件按到达顺序产出。整段结果拼好再返回也能跑，但界面就失去了逐字显示。
- `describeModel` 可选。不实现＝不声明任何能力：没有推理强度、没有上下文窗口、图片输入按「未知」处理（仍然放行，而不是隐藏）。

## 请求里有什么

| 字段 | 说明 |
| --- | --- |
| `messages` | 历史消息（含工具调用与工具结果） |
| `tools` | 模型可用的工具定义（JSON Schema） |
| `model` | 模型标识；省略时由适配器决定默认值 |
| `maxTokens` / `temperature` | 采样上限 |
| `reasoningEffort` | 推理强度 id，**由适配器自己声明取值**，内核原样转发 |
| `abortSignal` | 取消信号，适配器应尽快停止并结束流 |
| `responseFormat` | 结构化输出请求（`{ type: "json", schema? }`） |
| `cacheBreakpoints` | 提示缓存的锚点消息下标，适配器翻译成厂商机制 |
| `layerOrigins` | 上下文层的来源映射，用于缓存分层 |

## 事件怎么吐

| 事件 | 何时 |
| --- | --- |
| `text_delta` | 正文增量 |
| `reasoning_delta` | 推理/思考增量 |
| `tool_use_start` / `tool_use_delta` | 模型要调用工具：先给 id 与名字，再给参数增量 |
| `usage` | token 用量（输入/输出/缓存） |
| `done` | 本次调用结束，带 `stopReason` |
| `error` | 调用失败，带 `error` 与 `retriable?` |
| `usage_unavailable` | 请求了用量但厂商没给——只做可观测性提示，不影响流程 |

`done.stopReason` 有三个值：`end_turn`（说完了）、`tool_use`（要调工具）、`max_tokens`（被截断）。**填错这个词会让循环行为错乱**：说 `end_turn` 却不给结束信号，模型会被反复追问。

## 错误不要抛给内核

`stream` 内部出错时，正确做法是**产出 `error` 事件并结束流**，而不是 `throw`。内核会把错误归一化成一条模型错误输入回喂，让循环有机会自愈（换模型、重试、或直接告诉用户）。抛出异常会让这一轮直接炸掉。

`retriable: true` 表示值得重试（限流、超时）；`false` 表示重试也没用（鉴权失败、模型不存在）。

## 现成的适配器

| 包 | 用途 |
| --- | --- |
| `@volto/provider-pi-ai` | 默认。接内置供应商目录，或声明一个自定义 OpenAI 兼容端点 |
| `@volto/provider-openai` | 直接对 OpenAI 兼容接口 |
| `@volto/provider-anthropic` | 直接对 Anthropic Messages 接口 |

三个都实现了流式解析、工具调用增量累积与用量归一化。**自己写适配器时最容易错的两处**：工具调用参数是按增量分片到达的（要按 id 累积），以及厂商的结束原因要映射到上面三个值。

## 能力声明决定哪些功能出现

`describeModel` 返回的能力会改变装配：

- `reasoning` 有值 → 这个模型才有可选推理强度（没声明就只剩「不传」一种）。
- `input` 明确不含 `"image"` → 依赖图片的工具被摘除；未知则不摘（宁可让厂商回 400，也不要让工具莫名消失）。
- `cache` 声明 → 适配器按声明的机制打缓存断点。
- `contextWindow` → 上下文用量与压缩时机的依据。

## 出问题怎么办

- **界面一个字一个字都不出** → 适配器把整段缓冲到最后才吐，检查是否真的逐块 `yield`。
- **工具调用参数总是解析失败** → 没按 `toolCallId` 累积分片，或把多个工具的分片混在一起。
- **模型一直不收尾** → `stopReason` 映射错了。
- **推理强度选择器不见了** → `describeModel` 没实现或没返回 `reasoning`。