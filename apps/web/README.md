# @volto/web

Volto 的 Web 聊天端（Next.js + Tailwind + Zustand）。

Web 端**不内嵌 agent 内核**——它通过 SSE 协议连接 `apps/headless-server`。因此本地开发需要同时起两个进程。

## 本地联调

1. 在仓库根目录准备 `.env`（模型凭据）：

   ```bash
   OPENAI_API_KEY=sk-...
   OPENAI_BASE_URL=https://your-gateway.example.com/v1
   OPENAI_MODEL=gpt-4o
   ```

   `OPENAI_BASE_URL` 带不带 `/v1` 都可以，provider 会自动处理。

2. 启动 agent 网关（默认 `http://localhost:3100`）：

   ```bash
   pnpm --filter @volto/headless-server dev
   ```

3. 启动 Web 端（默认 `http://localhost:6100`）：

   ```bash
   pnpm --filter @volto/web dev
   ```

网关地址可通过 `NEXT_PUBLIC_AGENT_SERVER_URL` 覆盖。网关未启动时，聊天界面顶部会显示未连接提示。

## 传输协议

对话走 `@volto/sdk/sse` 定义的协议，分两条通道：

| 通道 | 方法 | 说明 |
| ---- | ---- | ---- |
| `/events?sessionId=` | GET | 每个会话一条长连接，服务端在此推送 `token` / `tool_call` / `tool_result` / `done` / `error` / `heartbeat` |
| `/messages` | POST | 提交 `{ sessionId, message }` 触发一轮对话，输出流回 `/events` 通道 |

采用「长连接 + POST 触发」而非 `GET /stream?message=`，是为了避开 URL 长度限制，并让一条连接承载多轮对话。

`sessionId` 由前端 session store 生成；服务端按 `sessionId` 隔离 agent 实例，因此**多轮上下文与会话隔离都由 sessionId 贯通**。

## 说明

- 会话与消息持久化在 `localStorage`（key: `volto-sessions`）。
- 工具调用卡片展示工具名、参数与执行状态；工具的原始输出只回传给模型，不进入对话流。
- 审批流（HITL）尚未接入 Web 端：网关当前使用自动放行的 ApprovalGate。
