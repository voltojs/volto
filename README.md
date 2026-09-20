# Volto

纯函数内核的通用 coding agent。核心（`@volto/core`）是零依赖、零副作用的状态机——`step(state, input) → { state, effects[] }`，时间 / 随机 / ID 全部经 port 注入；真正的副作用由薄解释器（Runner）在 core 之外执行。工具、模型供应商、运行时（沙箱 / Shell / 文件系统）、存储、宿主（网关 / Web UI / 桌面端）全部可插拔。

能力现状：多供应商模型接入（pi-ai 目录 + OpenAI 兼容）、持久 shell 会话与后台进程管理、子代理（声明式 AgentSpec + 工具集收窄）、图片链路（附件上传 / 视觉输入 / `read_file` 识图）、MCP（stdio）、会话持久化与审计轨迹（trajectory）、Web UI 与 Electron 桌面端。

## 快速开始

要求：**Node ≥ 22**、pnpm。

```bash
pnpm install
pnpm turbo run build

# 终端 1 —— 网关（HTTP + SSE，默认端口 3100）
cd apps/headless-server
pnpm start
# 启动日志会打印带一次性 token 的登录 URL

# 终端 2 —— Web UI（默认端口 6100）
cd apps/web
pnpm dev
```

打开网关打印的登录 URL（或 `http://localhost:6100/gateway?token=…`）完成鉴权，然后在「设置 → 模型配置」里添加供应商与 API Key（密钥加密存储在 `~/.volto/providers.json`，不落入浏览器）。选择一个工作区目录即可开始对话。

运行期数据都在用户级配置目录 `~/.volto/`（供应商、项目注册表、会话库、附件）。开发期也可用 `VOLTO_CONFIG_DIR` 指到别处。

## 平台支持矩阵

沙箱是**运行时事实**而非配置声明：只读 / 询问 / 自动三档承诺隔离，后端缺失时会**显式拒绝启动**，绝不静默裸跑。

| 平台 | 沙箱后端 | 只读 / 询问 / 自动 | 完全（danger-full-access） |
| --- | --- | --- | --- |
| macOS | seatbelt（`sandbox-exec`，系统内置） | 完整隔离 | 无隔离，可用 |
| Linux | bubblewrap（需自行安装 `bwrap`） | 隔离可用；个别语义与 macOS 存在差异（见源码内 PARITY NOTE，如 denied-read 用空 tmpfs 掩蔽，已持有 fd 的进程仍可继续读） | 无隔离，可用 |
| Windows / 其他 | **无** | **拒绝启动（显式报错）** | 无隔离，可用 |

可选依赖：`socat`——仅在沙箱内网络过滤（egress 代理）用到 TCP 桥接时需要，缺失时会有警告。

## 安全模型

沙箱边界防的是「模型犯错」，**不承诺**防「模型被诱导」。命令内容不做分类定级——`SAFETY.md` 论证了为什么"看起来挡得住"的错觉比不做更危险。平台支持的完整边界、已知不保护项、以及与沙箱 / 权限相关的威胁模型，见 [SAFETY.md](SAFETY.md)。

### 网络出口（egress）

`~/.volto/egress.json` 可约束 Network port 的三个工具（`web_fetch` / `web_search` / `http_query`）：

```json
{ "allowHosts": ["api.example.com"], "denyHosts": ["evil.example.net"] }
```

精确主机名匹配（大小写不敏感，无通配符），denylist 优先，被拒请求得到结构化 403；配置损坏会拒绝启动而非静默失效；改动对新构建的会话生效。**边界：该策略只作用于 Network port——模型自身的传输与 bash 里启动的任何进程（curl 等）都不经过它**，别把它当机器的出站防火墙。

### 参数级权限规则

`~/.volto/permissions.json`（改动在下一次会话重建时生效）：

```json
{
  "rules": [
    { "pathPattern": "**/.env", "decision": "ask" },
    { "toolName": "write_file", "pathPattern": "src/**", "decision": "allow" },
    { "hostPattern": "*.internal.example", "decision": "ask" }
  ]
}
```

- 规则按顺序匹配，第一条命中生效；`allow` / `deny` / `ask` 三档。
- 路径同时按绝对真实路径与工作区相对路径匹配，软链接会被跟随。
- 规则只能收紧权限，或在不越过沙箱边界的前提下减少询问；`read-only` 下任何 `allow` 规则都不会放行写入。
- 只对声明了路径 / URL 入参的工具生效，`bash` 不在此列。域名的硬边界是 `egress.json`。

### 命令前缀规则（减少询问，不是安全边界）

`~/.volto/permissions.json`（与上面同一份文件、同一组规则；改动在下一次会话重建时生效）：

```json
{
  "rules": [
    { "toolName": "bash", "commandPrefix": ["pnpm", "test"], "decision": "allow" }
  ]
}
```

- 只对**单一简单命令**生效：命令中出现 `;` `&` `|` `<` `>` 反引号 `$` `(` `)` `{` `}` `*` `?` `[` `]` `~` `\`、内部换行、前置环境变量赋值（`FOO=1 cmd`）或未闭合引号时，一律照旧询问。
- 匹配按 argv **逐 token 前缀**：`pnpm test --filter x` 命中，`pnpm test2` 不命中。
- 只允许 `allow`，且必须写明 `toolName`/`toolPattern`。
- **它不构成安全边界。** 它把"这条命令文本"的询问降为不问；等价效果的其他写法（`bash -c 'pnpm test'`、`pnpm test && …`）仍会被询问。
- 只对**声明了命令入参**的工具生效——当前只有 `bash`。写给其他工具（如 `run_tests`、`build`）的命令规则不会匹配，因为那些工具没有声明命令入参。
- **它不保证执行的是什么。** bash 默认使用持久会话，先前的命令可以留下 alias、shell 函数或改写 `PATH`——文本命中的 `pnpm test` 未必是 npm。`cwd` 也不受规则约束。

## 文档

| 文档 | 路径 | 用途 |
| --- | --- | --- |
| 架构设计 | [docs/pure-agent-core.md](docs/pure-agent-core.md) | 纯函数内核、ports 契约、模块分解 |
| 安全立场 | [SAFETY.md](SAFETY.md) | 威胁模型与边界强度 |
| 能力差距路线表 | [docs/capability-gap-roadmap.md](docs/capability-gap-roadmap.md) | 与成熟 agent 的差距分析与排期 |
| 演进路线图 | [docs/roadmap.md](docs/roadmap.md) | 内核平台化方向 |
| 特性 spec / plan | [docs/superpowers/](docs/superpowers/) | 每个特性的设计取舍与实施记录（按日期归档） |

## 开发

pnpm workspace + Turborepo monorepo：

```
packages/
  core/        # @volto/core   纯函数内核 + ports 接口（零依赖，CI 强制校验）
  sdk/         # @volto/sdk    门面 run / stream / resume
  tools/       # fs / shell / web / agent / mcp / … 每个子目录一个工具包
  providers/   # openai / anthropic / pi-ai
  runtimes/    # node / browser / edge（沙箱、Shell、文件系统等 adapter）
  stores/      # memory / file / jsonl / sqlite / postgres
  eval/        # @volto/eval   评测（replay + trajectory）
  embedders/ memories/   # 其他可插拔 adapter
apps/
  headless-server/   # HTTP + SSE 网关
  web/               # Next.js 聊天前端
  desktop-app/       # Electron 宿主
```

常用命令：

```bash
pnpm turbo run build        # 构建所有包
pnpm turbo run typecheck    # 类型检查
pnpm turbo run lint         # 代码检查（含 core 零依赖 / 纯度规则）
pnpm turbo run test         # 全部测试（vitest）
node scripts/check-core-zero-deps.mjs   # 校验核心包零运行时依赖
```

两条贯穿性约定：`packages/core/` 内禁止任何 I/O 与副作用（时间 / 随机 / ID 一律走 port 注入）；依赖单向向下（`core ← tools/providers/runtimes/stores ← sdk ← apps`）。详见 [AGENTS.md](AGENTS.md)。
