---
title: 自建宿主
type: guide
source:
  - packages/sdk/src/create-agent.ts
  - apps/gateway/src/wiring.ts
  - packages/tools/mcp/src
generated: false
verified: 2026-11-11
---

# 自建宿主

> 读完你会：知道官方网关替你做了什么，以及最小可用的宿主到底要写多少行。

## 官方网关做了什么

`apps/gateway` 不是内核的一部分，它只是一份**接线示例**：把 SDK 与 Node 侧实现接起来，再用 HTTP + SSE 暴露给前端。你可以整套换掉。

它替你做的事，按重要性排：

| 事情 | 对应 SDK 选项 / 端口 | 不做会怎样 |
| --- | --- | --- |
| 连模型 | `modelPort` | 跑不起来 |
| 读写文件 | `fs`（带沙箱装饰） | 文件类工具消失 |
| 执行命令 | `shell`（持久会话 + 沙箱） | 命令类工具消失 |
| 问用户 | `approvalGate` | 需要审批的调用直接失败 |
| 把过程送到界面 | `eventSink` | 界面只能等最终结果 |
| 存会话 | `sessionStore` + 转录 | 重启即失忆 |
| 权限档位 | `permissionConfig` | 用默认档（可写 + 每次询问） |
| 工作目录提醒 | `resolveWorkspaceReminder` | 模型不知道自己在哪个分支上 |
| 指令层 | `resolveContextLayers` | AGENTS.md 之类的项目约定进不了上下文 |
| 技能 | `skillRegistry` | 技能不可用 |
| 子代理定义 | `agentSpecs` | 只有内置类型 |
| 语言服务器 | `lsp` | 五个 `lsp_*` 工具消失 |
| sqlite | `db` | `db_query` 消失（`db_exec` 需要 `allowWrite`） |
| 浏览器 | `browserAdapter` | 浏览器工具消失 |

**「消失」是干净的降级**：没接的端口，对应工具直接从模型可见集里摘掉，模型不会去调用一个不存在的工具。

## 最小可用宿主

顺序很重要——先跑通一轮，再加东西：

1. `modelPort`（一个适配器即可）。
2. `run()` 跑一轮，确认能出字。
3. 加 `eventSink`，把 `text_delta` / `turn_end` 打到终端。
4. 加 `approvalGate`，用命令行问 yes/no。
5. 加 `fs` + `shell`，让工具真正能用。
6. 加 `sessionStore` + 转录，重启后能接着聊。

每一步都能独立验证，出问题时的排查面只有刚刚加的那一项。

## 接 MCP

官方网关还没接 MCP，自建宿主可以直接接：

```ts
import { McpToolSource, StdioTransport } from "@volto/tools-mcp";

const mcp = new McpToolSource({
  servers: [
    {
      serverId: "fs",
      transport: new StdioTransport({
        command: "npx",
        args: ["-y", "@modelcontextprotocol/server-filesystem", "/tmp"],
      }),
    },
  ],
});

// 交给 createAgent（modelPort 是你的模型连接）：
// const agent = createAgent({ modelPort, toolSources: [mcp] });
```

工具名会带上前缀（`mcp__<serverId>__<tool>`），能力串是 `mcp:<serverId>`——所以权限规则可以按服务器粒度写。

## 不要自己重造的部分

- **循环、上下文组装、压缩、工具路由、权限决策**：都在纯核心里，重写只会得到更差的版本。
- **错误归一化**：内核已经保证工具/模型错误不打断循环，宿主不必再包一层 try/catch。
- **可重放性**：只要端口注入正确，同一串输入两次运行结果一致；这是测试和排障的地基。

## 检查清单

- [ ] 每个接口都校验了输入（宿主是信任边界）
- [ ] 审批门在超时/异常时拒绝而不是放行
- [ ] `eventSink` 里没有同步阻塞的重活（它跑在循环路径上）
- [ ] 会话数据可删除（用户能要求忘掉某段对话）
- [ ] 沙箱状态对外可见（`full` / `partial` / `none`），而不是假装有隔离
- [ ] 密钥不进日志、不进模型上下文、不出现在错误信息里