# Volto 用户文档

Volto 是一个跑在本机的编程 agent：读你的仓库、改文件、执行命令，每一步都可以停下来问你。

按你的身份选一条路：

## 我是使用者（装好就用）

| 顺序 | 页面 | 你会得到 |
| --- | --- | --- |
| 1 | [安装并启动](using/tutorial/01-install.md) | 网关 + Web 界面跑起来并登录 |
| 2 | [配置模型并开始第一次对话](using/tutorial/02-first-conversation.md) | 配好供应商，让 agent 改一次代码 |
| 3 | [看懂改动、审批与恢复会话](using/tutorial/03-review-changes.md) | 知道它改了什么、什么时候在等你 |

常用手册：

- [模型与供应商](using/guides/models-and-providers.md) — 配 Key、模型能力、路由档位
- [工作区与会话](using/guides/workspace-and-sessions.md) — 工作区、会话找回、附件、导出
- [权限与审批](using/guides/permissions-and-approvals.md) — 四档权限、规则、一键记住
- [沙箱与平台支持](using/guides/sandbox-and-platforms.md) — 哪些平台能隔离、挡什么
- [网络出口名单](using/guides/network-egress.md) — 限制 agent 联网，以及它的边界
- [子代理与后台任务](using/guides/subagents-and-tasks.md) — 派活、收窄权限、自定义类型
- [用浏览器测网页](using/guides/browser-testing.md) — 让 Agent 自己点页面、读 console/网络、复用测试登录态
- [技能与 MCP](using/guides/skills-and-mcp.md) — 写技能；MCP 现在能用在哪
- [代码智能与数据库](using/guides/lsp-and-database.md) — 语言服务器与 SQLite
- [故障排查](using/guides/troubleshooting.md) — 按症状查原因

查表：

- [工具参考](using/reference/tools.md) — agent 能用哪些工具
- [配置文件参考](using/reference/config.md) — `~/.volto/config.json` 的每个字段
- [斜杠命令与输入技巧](using/reference/slash-commands.md) — `/plan` `/clear` `/compact` 与 `@` 引用

## 我是集成者（用 SDK 嵌进自己的宿主）

| 顺序 | 页面 | 你会得到 |
| --- | --- | --- |
| 1 | [把 agent 嵌进自己的宿主](integrating/tutorial/01-embed-agent.md) | 三十行代码跑通一轮对话 |

- [端口与默认实现](integrating/guides/ports-and-defaults.md) — 哪些必须自己接，哪些留默认
- [模型连接](integrating/guides/model-provider.md) — 自己实现 ModelPort，或判断现成适配器够不够
- [工具装配与权限策略](integrating/guides/tools-and-policy.md) — 四段流水线、可见性裁剪、审批门
- [事件流与界面](integrating/guides/events-and-ui.md) — 哪些事件可以依赖、断线怎么恢复
- [持久化与恢复](integrating/guides/persistence.md) — 快照、转录、压缩与导出
- [沙箱与钩子](integrating/guides/sandbox-and-hooks.md) — 隔离是否真的生效、钩子怎么写
- [自建宿主](integrating/guides/custom-host.md) — 官方网关做了什么，最小宿主怎么拼
- [SDK 导读](integrating/reference/sdk-api.md) — 选项分类、实例方法、错误契约
- [工具契约](integrating/reference/tool-contract.md) — 写一个能被正确调度的工具
- [SDK 导出清单](integrating/reference/sdk-exports.md) — 公开导出的完整列表
- [网关 HTTP 接口](integrating/reference/gateway-api.md) — 自建前端可以对接的契约

## 想先搞懂概念

- [一轮对话发生了什么](concepts/how-a-turn-works.md)
- [可见性与放行是两件事](concepts/tools-and-permissions.md)
- [为什么一切经端口注入](concepts/determinism-and-ports.md)
- [安全模型（用户版）](concepts/safety-model.md)

## 关于这份文档

- **写文档的规矩**在 [WRITING.md](WRITING.md)（人机共用）。
- 参考页里的工具、配置字段、网关接口由 `pnpm docs:gen` 从代码生成，不会与实现脱节。
- 发现某页与软件行为不一致，那就是 bug——`pnpm docs:check` 应该已经拦住它。
- 开发向的文档（架构、设计取舍、路线图）在 [`docs/superpowers/`](../superpowers/)，不是给使用者看的。