---
title: 把 agent 嵌进自己的宿主
type: tutorial
source:
  - packages/sdk/src/create-agent.ts
  - packages/sdk/src/defaults.ts
  - packages/providers/pi-ai/src/model-port.ts
generated: false
verified: 2026-11-13
---

# 把 agent 嵌进自己的宿主

> 读完你会：用三十行代码跑通一轮对话，再把模型换成真的。

## 前提

- **Node ≥ 22**（`node -v` 确认）。
- **GitHub Packages 的读取权限**。`@voltojs/*` 发布在 GitHub Packages 上，**默认私有**，所以 `npm i @voltojs/sdk` 之前要先配 registry 和一个勾了 `read:packages` 的 GitHub personal access token（classic）。把这两行写进 `~/.npmrc`：

  ```text
  @voltojs:registry=https://npm.pkg.github.com
  //npm.pkg.github.com/:_authToken=${GITHUB_NPM_AUTH_TOKEN}
  ```

  token 本身放在 shell 配置里（`~/.zshrc` 中 `export GITHUB_NPM_AUTH_TOKEN=ghp_…`）。用 `npm whoami --registry=https://npm.pkg.github.com` 确认生效；token 不要写进项目里的 `.npmrc`，项目级配置优先，会把 `~/.npmrc` 里的凭据覆盖成空值。CI 里通常改用 `NODE_AUTH_TOKEN`（见 [发布与安装](../guides/publishing.md)）。没有这步会得到 `404`。
- 装 SDK：

  ```bash
  npm i @voltojs/sdk
  ```

- **只提供 ESM 入口**（`package.json` 里没有 `require`）。你的宿主用 `import` 就直接写；宿主是 CommonJS 时，用动态 `import()` 把它当模块加载：

  ```js
  // CommonJS 宿主（.cjs / "type" 不是 "module" 的老包）
  const { createAgent } = await import("@voltojs/sdk");
  ```

  Node 20.19 / 22.12 起 `require()` 也能加载 ESM，但 SDK 的实际支持基准是 Node 22，别依赖更早的行为。

- 可选包按需单独装，不全在 `@voltojs/sdk` 里：`@voltojs/provider-pi-ai`、`@voltojs/provider-openai`、`@voltojs/provider-anthropic`、`@voltojs/store-sqlite` 等。下面第一步只用 `@voltojs/sdk` 自带的默认值，可以先不装。

## 第一步：用假模型验证接线

`createAgent` 只有一个必填项：模型连接（`modelPort`）。先用一个脚本化模型跑通，不联网、不需要 Key：

```ts
import { createAgent } from "@voltojs/sdk";
import type { ModelPort } from "@voltojs/sdk";

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

这一次调用已经走完了全部真实路径——核心状态机、工具路由器、事件流——只是模型部分被换成了假的。接错线在这里暴露，而不是在付费请求里。

## 第二步：换成真模型

用 pi-ai 适配器接一个 OpenAI 兼容端点（自定义供应商）。换成任何厂商只是换 `providers` 里的配置。先装这个适配器：

```bash
npm i @voltojs/provider-pi-ai
```

```ts
import { createAgent } from "@voltojs/sdk";
import { createPiAiModelPort } from "@voltojs/provider-pi-ai";

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