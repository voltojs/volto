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

## 项目与模型

添加项目时会弹出系统原生的目录选择对话框。该对话框由**网关进程**弹出，因此网关必须运行在有图形界面的机器上。在 SSH、Docker 等无图形界面的环境下，网关不会挂起，但具体表现取决于对话框命令是否安装：命令缺失（或平台不受支持）时返回 501 并给出说明；命令已安装但没有图形会话可附着时，命令通常以非零退出码、空输出结束，这与用户主动取消在协议上无法区分，因此接口会返回与取消相同的 `{ path: null }`，界面上不会有任何提示。换言之，在真正无图形界面的环境下添加项目会**静默失败**，而不总是有错误提示。

项目（会话运行的目录）和供应商/模型都保存在网关侧的 `~/.volto/`：

- `~/.volto/projects.json` — 项目列表
- `~/.volto/providers.json` — 供应商与模型，其中 apiKey 以 AES-256-GCM 加密
- `~/.volto/key` — 加密密钥（权限 0600，首次运行自动生成）

这层加密防的是配置文件被误提交或误分享时的明文泄露；同一台机器上能读到 key 文件的进程仍可解密。

apiKey 不会返回给浏览器，界面上只显示掩码。

会话在创建时绑定项目且之后不可更改；模型与权限档位可随时切换，切换后下一条消息即生效，历史上下文保留。

权限档位有两档：

| 档位 | 只读操作 | 普通写操作 | 不可逆操作 |
| --- | --- | --- | --- |
| 规划模式 | 允许 | 拒绝 | 拒绝 |
| 完全权限 | 允许 | 允许 | 拒绝 |

不可逆操作在两档下都被拒绝，因为网关尚未接入人工审批流。

网关默认只监听 `127.0.0.1`。由于前端可以指定任意绝对路径作为项目根目录，请不要在未加认证的情况下把它绑定到对外网卡。

## 说明

- 会话与消息持久化在 `localStorage`（key: `volto-sessions`）。
- 工具调用卡片展示工具名、参数与执行状态；工具的原始输出只回传给模型，不进入对话流。
- 审批流（HITL）尚未接入 Web 端：网关当前使用自动放行的 ApprovalGate。
