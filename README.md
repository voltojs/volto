# Volto

跑在本机的编程 agent。核心（`@volto/core`）是零依赖、零副作用的状态机——`step(state, input) → { state, effects[] }`，时间 / 随机 / ID 全部经端口注入，真正的副作用由薄解释器在核心之外执行。工具、模型供应商、运行时（沙箱 / Shell / 文件系统）、存储、宿主（网关 / Web UI / 桌面端）全部可插拔。

## 快速开始

要求 **Node ≥ 22**（macOS / Linux）。

```bash
npx @volto/gateway
```

网关同时提供 API 和 Web 界面，启动（`volto` 或 `volto serve`）后只打印两行：

```text
volto gateway 0.1.0 listening on http://127.0.0.1:3100
Open: http://127.0.0.1:3100/?token=…
```

另有 `volto web`（界面单独一个端口、API 转发回网关）会多打印第三行 `Login:`，那条链接带的是持久 token。

打开 `Open:` 那个网址即可登录（token 会换成 cookie，之后 `http://127.0.0.1:3100/` 直接可进；没自动开浏览器时就手动粘这个链接）。然后在「设置 → 模型配置」里加供应商与 API Key，选一个工作区目录就能开始对话。

- `npx @volto/gateway doctor` — 检查这台机器能否运行（Node 版本 / 沙箱 / 配置目录 / 会话库 / 端口）
- `npx @volto/gateway token` — 打印持久 token 与登录链接；`--rotate` 立即作废已登录的浏览器
- 从手机或另一台电脑用：[远程访问](docs/user/using/guides/remote-access.md)

逐步说明（含每一步「你应看到」）：[安装并启动](docs/user/using/tutorial/01-install.md)。从源码跑、开发前端见同一页的「从源码运行 / 给贡献者」一节。

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
pnpm install
pnpm turbo run build
pnpm turbo run typecheck    # 类型检查
pnpm turbo run lint         # 代码检查（含核心零依赖 / 纯度规则）
pnpm turbo run test         # 测试（vitest）
pnpm docs:check             # 用户文档门（链接 / 生成页 / 表面漂移）
```

pnpm workspace + Turborepo：`packages/`（core · sdk · tools · providers · runtimes · stores · eval · embedders · memories）+ `apps/`（gateway · web · desktop-app）。

两条贯穿性约定：`packages/core/` 内禁止任何 I/O 与副作用；依赖单向向下（`core ← tools/providers/runtimes/stores ← sdk ← apps`）。细节与架构文档索引见 [AGENTS.md](AGENTS.md)。