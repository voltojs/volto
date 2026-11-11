---
title: 把 agent 嵌进自己的宿主
type: tutorial
source:
  - packages/sdk/src/create-agent.ts
  - packages/sdk/src/defaults.ts
  - packages/providers/pi-ai/src/model-port.ts
generated: false
verified: 2026-11-11
---

# 把 agent 嵌进自己的宿主

> 读完你会：用三十行代码跑通一轮对话，再把模型换成真的。

## 前提

- 仓库内使用：`@volto/sdk` 是 workspace 包，**不发布 npm**，在 monorepo 里直接依赖即可。
- Node ≥ 22，仓库已 `pnpm install && pnpm turbo run build`。

## 第一步：用假模型验证接线

`createAgent` 只有一个必填项：模型连接（`modelPort`）。先用一个脚本化模型跑通，不烧 token、不需要 Key：

```ts
import { createAgent } from "@volto/sdk";
import type { ModelPort } from "@volto/sdk";

// 脚本化模型：不联网，也不读环境变量。先用它确认接线正确。
const scripted: ModelPort = {
  async *stream() {
    yield { type: "text_delta", text: "你好，" };
    yield { type: "text_delta", text: "我在。" };
    yield { type: "done", stopReason: "end_turn" };
  },
};

const agent = createAgent({ modelPort: scripted });

for await (const event of agent.stream("介绍一下你自己")) {
  if (event.type === "text_delta") process.stdout.write(String(event.data.text ?? ""));
}
```

你应看到：`你好，我在。`

这一次调用已经走完了全部真实路径——核心状态机、工具路由器、事件流——只是模型部分被换成了假的。**这正是一个可替换内核的意义**：接错线在这里暴露，而不是在付费请求里。

## 第二步：换成真模型

用 pi-ai 适配器接一个 OpenAI 兼容端点（自定义供应商）。换成任何厂商只是换 `providers` 里的配置：

```ts
import { createAgent } from "@volto/sdk";
import { createPiAiModelPort } from "@volto/provider-pi-ai";

const modelPort = createPiAiModelPort({
  providers: [
    {
      kind: "custom",
      id: "my-gateway",
      baseURL: "https://api.example.com/v1",
      apiKey: process.env.OPENAI_API_KEY,
      models: [{ code: "gpt-4.1-mini", contextWindow: 128_000 }],
    },
  ],
  defaultProviderId: "my-gateway",
  defaultModel: "gpt-4.1-mini",
});

const agent = createAgent({ modelPort });
const state = await agent.run("用一句话说明你刚做了什么");
console.log(state.status); // "done"
```

`run()` 跑到本轮结束并返回最终状态；想边跑边渲染就换成 `stream()`。同一实例**一次只能跑一轮**，并发会话请各自 `createAgent()`。

## 接下来要接的东西

默认值能让上面两段代码跑起来，但一个真宿主迟早要接这些：

| 想做的事 | 对应选项 | 详见 |
| --- | --- | --- |
| 真的读写文件 | `fs`（否则文件类工具从可见集里摘掉） | [端口与默认实现](../guides/ports-and-defaults.md) |
| 真的执行命令 | `shell` | 同上 |
| 让用户点「允许」 | `approvalGate` | 同上 |
| 把界面要的事件接出去 | `eventSink` | 同上 |
| 会话持久化 / 恢复 | `sessionStore` + `chatStore` | 同上 |
| 限制能用的工具 | `capabilities` / `tools` / `toolSources` | [工具契约](../reference/tool-contract.md) |

## 出问题怎么办

- **模型不调用任何工具**：多半是 `fs` / `shell` 没传——没有对应端口的工具不会出现在可见集里，模型根本不知道它们存在。
- **一调用工具就报错**：工具执行错误会以 `isError: true` 的结果回喂模型（不会抛异常打断循环），看模型下一轮怎么说，或打开 `eventSink` 看原始事件。

完整选项见 [SDK 导读](../reference/sdk-api.md)。