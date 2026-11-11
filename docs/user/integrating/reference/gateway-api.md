---
title: 网关 HTTP 接口
type: reference
generated: true
source:
  - apps/headless-server/src/server.ts
verified: 2026-11-11
---
<!-- GENERATED FILE — do not edit by hand.
     由 `pnpm docs:gen` 从代码与下面的 notes 文件生成；手改会被 `pnpm docs:check` 判为漂移。
     要改内容：改 notes JSON 或改代码，然后重新生成。 -->

# 网关 HTTP 接口

网关（`apps/headless-server`）是官方宿主：它把 SDK 与模型、沙箱、文件系统接线，再用 HTTP + SSE 暴露给 Web UI 与桌面端。

**对外契约**指自建宿主或替代前端可以直接依赖的接口：路径、方法、鉴权方式与响应形状保持向后兼容。也可以完全不用网关，直接调 `@volto/sdk`（见 [接入 SDK](../tutorial/01-embed-agent.md)）。

## 对外契约

| 方法 | 路径 | 用途 |
| --- | --- | --- |
| `GET` | `/agents` | 子代理定义列表（项目 / 用户 / 插件三个来源合并）。 |
| `POST` | `/agents` | 在指定作用域新建一个子代理定义。 |
| `POST` | `/approvals` | 对一个待审批的工具调用给出 allow / deny / 回答。 |
| `GET` | `/catalog/providers` | 内置供应商目录，供「添加供应商」表单选择。 |
| `GET` | `/commands` | 斜杠命令的模板列表，`/` 面板的数据源。 |
| `GET` | `/config/routing-tiers` | 模型路由档位表；首次写入前是出厂模板。 |
| `PUT` | `/config/routing-tiers` | 整体替换路由档位表；删除仍被引用的档位会返回 409。 |
| `GET` | `/events` | 一个会话的 SSE 长连接：模型增量、工具调用、审批请求、回合结束都从这里出。 |
| `GET` | `/health` | 存活检查：网关进程是否已就绪。 |
| `POST` | `/interrupt` | 取消当前正在进行的回合。 |
| `POST` | `/messages` | 触发一轮对话；流式事件从该会话的 `GET /events` 返回。 |
| `POST` | `/messages/queue` | 编辑或撤回尚未送达模型的排队消息。 |
| `GET` | `/preferences` | 界面默认值：下一段对话从哪一档权限、哪种语言与主题开始。 |
| `PUT` | `/preferences` | 把给定的键合并进默认值。 |
| `GET` | `/projects` | 已注册的工作区列表。 |
| `POST` | `/projects` | 注册一个工作区目录。 |
| `GET` | `/providers` | 已配置的模型供应商（密钥只以密文形式存在，不返回明文）。 |
| `POST` | `/providers` | 新增一个供应商及其模型清单。 |
| `POST` | `/resume` | 带人工决策恢复一次挂起执行（旧接口）。 |
| `POST` | `/run` | 一次性执行并返回最终状态（旧接口，多轮请用 /messages）。 |
| `GET` | `/sessions` | 会话列表，供会话恢复与侧边栏使用。 |
| `GET` | `/sidebar-state` | 侧边栏布局文档（置顶、顺序）。 |
| `PUT` | `/sidebar-state` | 整体替换侧边栏布局文档。 |
| `GET` | `/skills` | 技能目录（含用户可主动调用的技能）。 |
| `GET` | `/stream` | 一次性 SSE，吐出原始内部事件（旧接口）。 |
| `GET` | `/tools` | 工具目录，供「配置子代理」时勾选工具范围。 |

## 内部接口（跟随 UI 变动，不承诺兼容）

| 方法 | 路径 | 归类 |
| --- | --- | --- |
| `*` | `/config/routing-tiers` | ·待补· |
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

- 除登录跳转与 `/health` 外，请求需携带启动时打印的一次性 token；Web UI 在 URL 上完成换取后写入 cookie。
- 请求与响应体为 JSON；一轮对话的流式事件走 `GET /events` 的 SSE 长连接（`@volto/sdk/sse` 有对应客户端）。

> 这张表由 `pnpm docs:gen` 从 `server.ts` 抽取路由，用途来自 `docs/user/reference/gateway-notes.json`。新增或删除路由会让 `pnpm docs:check` 失败，直到 notes 同步。
