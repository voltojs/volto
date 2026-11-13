# @voltojs/web

Volto 的 Web 聊天端（Next.js + Tailwind + Zustand）。

Web 端**不内嵌 agent 内核**——它通过 SSE 协议连接 `apps/gateway`。因此本地开发需要同时起两个进程。

这个包是私有应用，不发布；它依赖的 `@voltojs/*` 包发布在 npm 公共 registry 上。在仓库里开发用 workspace 链接；脱离仓库单独装这些包时直接 `npm i @voltojs/...` 即可，不需要额外配置，见[发布与安装](../../docs/user/integrating/guides/publishing.md)。

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
   pnpm --filter @voltojs/gateway dev
   ```

3. 启动 Web 端（默认 `http://localhost:6100`）：

   ```bash
   pnpm --filter @voltojs/web dev
   ```

4. **认证**：用网关启动时打印的 `Open:` 链接登录，再把里面 `/?token=…` 的 token 带到前端
   自己的地址上（同一个凭据，换一个源）：

   ```
   Open:  http://127.0.0.1:3100/?token=…      ← 网关打印的两行之一（serve）
   →      http://localhost:6100/gateway?token=…   ← 开发时把 token 拼到这里
   ```

   这一步不可跳过——直接访问 `http://localhost:6100` 会看到侧边栏报
   `无法连接 agent 服务：Unauthorized`。地址栏打开带 token 的页面后，网关会把 token 换成一个
   HttpOnly cookie 并**重定向到同一页面去掉 `token` 的地址**（其它查询参数保留），所以 token
   不会留在地址栏、浏览器历史或 Referer 里。只有浏览器的一次页面导航会这样换：
   `fetch()` 之类的程序化请求不会被重定向。cookie 有效期 7 天，之后重新走一遍这一步即可。

   launch token **每次启动网关都会重新生成**，旧 URL 随进程一起失效；要跨重启就用持久 token
   （`volto token` 打印的那条 `Open:` 链接）。

## 认证

网关地址是**运行时**数据，由 `lib/gateway-base.ts` 的 `getGatewayBase()` 解析
（首次调用后缓存），所有请求统一经 `gatewayUrl(path)` 拼接：

1. `localStorage["volto.gatewayUrl"]`——本浏览器的临时覆盖；
2. `window.__VOLTO_CONFIG__.gatewayUrl`——部署注入的配置
   （`public/volto-config.js`，可被宿主替换）；
3. 默认值：`next dev` 下是 `/gateway`（让 `next.config.ts` 的 rewrite 继续
   命中），其余构建（含导出产物）是空串，即同源直连。

cookie 认证依赖浏览器只看到一个 origin，所以部署时不要把它配成跨域地址。
`NEXT_PUBLIC_AGENT_SERVER_URL` 只影响**服务端 rewrite 的目标地址**
（默认 `http://localhost:3100`），不是浏览器直连的地址。

非浏览器客户端（curl、脚本）把同样的 token（launch token 或持久 token）作为 bearer：

```bash
curl -H "Authorization: Bearer $TOKEN" http://127.0.0.1:3100/sessions
```

除 `/health` 外的每条路由都要求认证，未认证一律返回统一的 401——包括不存在
的路径，避免未认证方枚举路由。WebSocket 升级走同一条鉴权链。

## 传输协议

对话走 `@voltojs/sdk/sse` 定义的协议，分两条通道：

| 通道 | 方法 | 说明 |
| ---- | ---- | ---- |
| `/events?sessionId=` | GET | 每个会话一条长连接，服务端在此推送 `token` / `tool_call` / `tool_result` / `done` / `error` / `heartbeat` |
| `/messages` | POST | 提交 `{ sessionId, message }` 触发一轮对话，输出流回 `/events` 通道 |

采用「长连接 + POST 触发」而非 `GET /stream?message=`，是为了避开 URL 长度限制，并让一条连接承载多轮对话。

`sessionId` 由前端 session store 生成；服务端按 `sessionId` 隔离 agent 实例，因此**多轮上下文与会话隔离都由 sessionId 贯通**。

## 项目与模型

添加项目时默认会弹出系统原生的目录选择对话框。该对话框由**网关进程**弹出，因此网关必须运行在有图形界面的机器上。

远程模式（`--serve-remote`）下网关没有这个能力：`GET /gateway-info` 的
`capabilities.nativeDialogs` 为 `false`，界面会改为让你**填一个绝对路径**（网关那台机器上的路径），
不再调用对话框；万一仍然收到 `501 capability_unavailable`，也会换成可读提示并切到这个入口。

其它无图形界面的环境（SSH、Docker）网关不会挂起，但具体表现取决于对话框命令是否安装：命令缺失
（或平台不受支持）时返回 501 并给出说明；命令已安装但没有图形会话可附着时，命令通常以非零退出码、
空输出结束，这与用户主动取消在协议上无法区分，因此接口会返回与取消相同的 `{ path: null }`，界面上
不会有任何提示。换言之，这类环境下添加项目可能**静默失败**，而不总是有错误提示。

**验证状态**：macOS 一条命令已实测通过（对话框正常弹出，路径正确写回）。Linux（`zenity` / `kdialog`）与 Windows（`powershell` + `FolderBrowserDialog`）两条命令均已实现，但尚未在对应平台实测验证。

项目（会话运行的目录）和供应商/模型都保存在网关侧的 `~/.volto/`：

- `~/.volto/projects.json` — 项目列表
- `~/.volto/providers.json` — 供应商与模型，其中 apiKey 以 AES-256-GCM 加密
- `~/.volto/key` — 加密密钥（权限 0600，首次运行自动生成）

这层加密防的是配置文件被误提交或误分享时的明文泄露；同一台机器上能读到 key 文件的进程仍可解密。

apiKey 不会返回给浏览器，界面上只显示掩码。

会话在创建时绑定项目且之后不可更改；模型与权限档位可随时切换，切换后下一条消息即生效，历史上下文保留。

权限预设有四档。每档只是内核两个正交旋钮（沙箱边界 × 审批策略）的一个组合，见 `apps/gateway/src/permission-modes.ts`：

| 预设 | sandbox | approval | 只读 | 普通写 | 高危写 | 不可逆 |
| --- | --- | --- | --- | --- | --- | --- |
| read-only | read-only | never | 允许 | 拒绝 | 拒绝 | 拒绝 |
| ask（默认） | workspace-write | ask | 允许 | 允许 | 询问 | 询问 |
| auto | workspace-write | never | 允许 | 允许 | 允许 | 拒绝 |
| full | danger-full-access | never | 允许 | 允许 | 允许 | 允许 |

同一个 sandbox 值同时驱动权限判定和 shell / filesystem 装饰器，所以"判定放不放行"与"实际能不能做到"来自同一个源。

网关**默认只绑定** `127.0.0.1` / `localhost` / `::1`。绑定到对外网卡（`--host 0.0.0.0` 等）必须显式加
`--serve-remote`，否则启动时直接报错退出——因为前端可以指定任意绝对路径作为项目根目录，且 agent 会执行
任意命令，绑定到对外网卡等于把整台机器交出去。远程模式同时：要求访问 token、关掉原生对话框（`/fs/pick-directory`、
`/fs/reveal` 返回 `501 capability_unavailable`），`GET /gateway-info` 的 `mode` 变成 `remote`。外网访问的完整做法见
[远程访问](../../docs/user/using/guides/remote-access.md)。

沙箱化的子进程读不到网关自己的凭据目录（`~/.volto`，shell 与 fs 两侧都拒），环境变量里名字形如 `*API_KEY*` / `*TOKEN*` / `*SECRET*` / `*PASSWORD*` / `*CREDENTIAL*` 的也会在进入子进程前被剥离。`SSH_AUTH_SOCK` 是有意保留的——剥掉它 `git push` 就不能用了。

## 能力契约（`GET /gateway-info`）

客户端启动时取一次 `GET /gateway-info`（`lib/capabilities.ts` 的 `loadCapabilities`，由
`components/capabilities-boot.tsx` 在应用外壳里挂载），读 `capabilities`：

| 字段 | 客户端的用法 |
| --- | --- |
| `nativeDialogs` | 为 `false`（远程模式）时，「添加工作区」改为填网关那台机器上的路径，不再调用系统目录对话框；其它失败里的 `501 capability_unavailable` 也换成可读文案并切到这个入口 |
| `browserAutomation` / `lsp` | 目前只用于展示，不影响界面行为 |

拿不到答案（未取到、请求失败、旧网关没有这个字段）一律按 `nativeDialogs` 可用处理——保持旧行为，
不会因为一次失败把界面切到「远程模式」。

## 说明

- 会话与消息不做客户端持久化：`gateway` 的 jsonl transcript 是唯一真源，浏览器侧只在内存中保存当前打开的会话；刷新页面会重新从 `GET /sessions` / `GET /sessions/:id` 拉取。
- 工具调用卡片展示工具名、参数与执行状态；工具的原始输出只回传给模型，不进入对话流。
- 审批流（HITL）已接入：`ask` 预设下高危与不可逆操作会在对话流里弹出审批卡片。每次审批都绑定在展示它的那条 SSE 连接上（`/events` 建连时下发的 `token`），同一用户的另一个标签页无法替它做决定。
