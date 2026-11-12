---
title: 网关 HTTP 接口
type: reference
generated: true
source:
  - apps/gateway/src/server.ts
verified: 2026-11-11
---
<!-- GENERATED FILE — do not edit by hand.
     由 `pnpm docs:gen` 从代码与下面的 notes 文件生成；手改会被 `pnpm docs:check` 判为漂移。
     要改内容：改 notes JSON 或改代码，然后重新生成。 -->

# 网关 HTTP 接口

网关（`apps/gateway`）是官方宿主：它把 SDK 与模型、沙箱、文件系统接线，再用 HTTP + SSE 暴露给 Web UI 与桌面端。

**对外契约**指自建宿主或替代前端可以直接依赖的接口：路径、方法、鉴权方式与响应形状保持向后兼容。也可以完全不用网关，直接调 `@volto/sdk`（见 [接入 SDK](../tutorial/01-embed-agent.md)）。

## 对外契约

| 方法 | 路径 | 用途 |
| --- | --- | --- |
| `GET` | `/agents` | 子代理定义列表（项目 / 用户 / 插件三个来源合并）。 |
| `POST` | `/agents` | 在指定作用域新建一个子代理定义。 |
| `DELETE` | `/agents/*` | 删除一个子代理定义；内置类型不可删（可被同名覆盖）。 |
| `PUT` | `/agents/*` | 替换一个子代理定义；插件来源的条目返回 409。 |
| `POST` | `/approvals` | 对一个待审批的工具调用给出 allow / deny / 回答。 |
| `GET` | `/catalog/providers` | 内置供应商目录，供「添加供应商」表单选择。 |
| `GET` | `/commands` | 斜杠命令的模板列表，`/` 面板的数据源。 |
| `GET` | `/config/browser` | 网关所在系统的浏览器设置：当前 executablePath、解析结果与已探测浏览器。 |
| `PUT` | `/config/browser` | 把 `executablePath` 写入 config.json；null 表示删除并回到自动探测。需重启网关生效。 |
| `GET` | `/config/routing-tiers` | 模型路由档位表；首次写入前是出厂模板。 |
| `PUT` | `/config/routing-tiers` | 整体替换路由档位表；删除仍被引用的档位会返回 409。 |
| `GET` | `/events` | 一个会话的 SSE 长连接：模型增量、工具调用、审批请求、回合结束都从这里出。 |
| `GET` | `/gateway-info` | 这个网关实例的模式与能力事实：`mode` 为 `local` 或 `remote`（用 `--serve-remote` 启动时为 `remote`）。`capabilities.nativeDialogs`：本实例是否提供原生目录选择 / 在文件管理器中显示（`remote` 模式下为 `false`，此时 `/fs/pick-directory`、`/fs/reveal` 返回 501）；`capabilities.browser`：是否真的创建了浏览器宿主（浏览器配置关闭或找不到浏览器可执行文件时为 `false`）；`capabilities.lsp`：是否至少配置了一个语言服务器（`lsp.servers` 为空时为 `false`）。需要鉴权。 |
| `GET` | `/health` | 存活检查：网关进程是否已就绪。 |
| `POST` | `/interrupt` | 取消当前正在进行的回合。 |
| `POST` | `/messages` | 触发一轮对话；流式事件从该会话的 `GET /events` 返回。 |
| `POST` | `/messages/queue` | 编辑或撤回尚未送达模型的排队消息。 |
| `GET` | `/preferences` | 界面默认值：下一段对话从哪一档权限、哪种语言与主题开始。 |
| `PUT` | `/preferences` | 把给定的键合并进默认值。 |
| `GET` | `/projects` | 已注册的工作区列表。 |
| `POST` | `/projects` | 注册一个工作区目录。 |
| `DELETE` | `/projects/*` | 从注册表移除一个工作区（不动磁盘目录）。 |
| `GET` | `/providers` | 已配置的模型供应商（密钥只以密文形式存在，不返回明文）。 |
| `POST` | `/providers` | 新增一个供应商及其模型清单。 |
| `DELETE` | `/providers/*` | 删除一个供应商及其模型配置。 |
| `POST` | `/providers/*` | 供应商的单个动作族：目前是 `POST /providers/:id/probe`（用当前配置真发一次最小请求，验证路由可用）。 |
| `PUT` | `/providers/*` | 整体替换一个供应商的配置（模型清单连同覆盖项）。 |
| `POST` | `/resume` | 带人工决策恢复一次挂起执行（旧接口）。 |
| `POST` | `/run` | 一次性执行并返回最终状态（旧接口，多轮请用 /messages）。 |
| `GET` | `/sessions` | 会话列表，供会话恢复与侧边栏使用。 |
| `DELETE` | `/sessions/*` | 删除一段会话及其转录。 |
| `GET` | `/sessions/*` | 单条会话的读取族：完整转录、轨迹、原始事件、计划文档、导出。具体子路径见 server.ts 的 `/sessions/:id/...` 注释。 |
| `PATCH` | `/sessions/*` | 重命名会话（标题按最后写入生效）。 |
| `GET` | `/sidebar-state` | 侧边栏布局文档（置顶、顺序）。 |
| `PUT` | `/sidebar-state` | 整体替换侧边栏布局文档。 |
| `GET` | `/skills` | 技能目录（含用户可主动调用的技能）。 |
| `GET` | `/stream` | 一次性 SSE，吐出原始内部事件（旧接口）。 |
| `GET` | `/tools` | 工具目录，供「配置子代理」时勾选工具范围。 |

## 内部接口（跟随 UI 变动，不承诺兼容）

| 方法 | 路径 | 归类 |
| --- | --- | --- |
| `GET` | `/file-refs` | 内部 |
| `GET` | `/fs/file` | 内部 |
| `GET` | `/fs/search` | 内部 |
| `GET` | `/fs/tree` | 内部 |
| `GET` | `/git/branches` | 内部 |
| `GET` | `/git/graph` | 内部 |
| `GET` | `/git/summary` | 内部 |
| `POST` | `/fs/pick-directory` | 内部 |
| `POST` | `/fs/reveal` | 内部 |
| `POST` | `/git/branches` | 内部 |
| `POST` | `/git/checkout` | 内部 |

## 鉴权与传输

- 除 `/health` 外都要鉴权：带 `Authorization: Bearer <launchToken>`，或先访问任意路径并在查询串上带 `?token=<launchToken>`——网关会换取一个 cookie 并重定向回干净路径，token 不再留在地址栏。
- 请求与响应体为 JSON；一轮对话的流式事件走 `GET /events` 的 SSE 长连接（`@volto/sdk/sse` 有对应客户端）。

> 这张表由 `pnpm docs:gen` 从 `server.ts` 抽取路由，用途来自 `docs/user/reference/gateway-notes.json`。新增或删除路由会让 `pnpm docs:check` 失败，直到 notes 同步。
