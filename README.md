# Volto

跑在本机的编程 agent。核心（`@volto/core`）是零依赖、零副作用的状态机——`step(state, input) → { state, effects[] }`，时间 / 随机 / ID 全部经端口注入，真正的副作用由薄解释器在核心之外执行。工具、模型供应商、运行时（沙箱 / Shell / 文件系统）、存储、宿主（网关 / Web UI / 桌面端）全部可插拔。

## 快速开始

要求 **Node ≥ 22**、pnpm。

```bash
pnpm install
pnpm turbo run build

cd apps/headless-server && pnpm start   # 终端 1：网关（:3100），会打印带 token 的登录 URL
cd apps/web && pnpm dev                  # 终端 2：Web 界面（:6100）
```

用网关打印的 `Or open the web app URL` 打开浏览器，然后在「设置 → 模型配置」里加供应商与 API Key，选一个工作区目录即可开始对话。

逐步说明（含每一步「你应看到」）：[安装并启动](docs/user/using/tutorial/01-install.md)。

## 文档

| 你是 | 从这开始 |
| --- | --- |
| **使用者**（装好就用） | [用户文档索引](docs/user/README.md) — 教程 · 权限 · 沙箱 · 工具 · 配置 · 故障排查 |
| **集成者**（用 SDK 嵌进自己的宿主） | [把 agent 嵌进自己的宿主](docs/user/integrating/tutorial/01-embed-agent.md) |
| **贡献者** | [AGENTS.md](AGENTS.md) — 开发规约、质量门、目录结构 |
| **想知道边界** | [用户版安全模型](docs/user/concepts/safety-model.md) · [完整威胁模型](SAFETY.md) |

平台支持：macOS 用系统自带 seatbelt，Linux 需自装 `bubblewrap`；没有沙箱后端的平台（含 Windows）网关会**拒绝启动**，而不是静默裸跑。见 [沙箱与平台支持](docs/user/using/guides/sandbox-and-platforms.md)。

用户级数据都在 `~/.volto/`：配置集中在 `config.json`（分区字段见[配置参考](docs/user/using/reference/config.md)），会话库、附件、agents、skills 各自独立目录。

## 开发

```bash
pnpm turbo run typecheck    # 类型检查
pnpm turbo run lint         # 代码检查（含核心零依赖 / 纯度规则）
pnpm turbo run test         # 测试（vitest）
pnpm docs:check             # 用户文档门（链接 / 生成页 / 表面漂移）
```

pnpm workspace + Turborepo：`packages/`（core · sdk · tools · providers · runtimes · stores · eval · embedders · memories）+ `apps/`（headless-server · web · desktop-app）。

两条贯穿性约定：`packages/core/` 内禁止任何 I/O 与副作用；依赖单向向下（`core ← tools/providers/runtimes/stores ← sdk ← apps`）。细节与架构文档索引见 [AGENTS.md](AGENTS.md)。