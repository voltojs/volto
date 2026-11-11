---
title: 配置文件参考
type: reference
generated: true
source:
  - apps/headless-server/src/config/*.ts
verified: 2026-11-11
---
<!-- GENERATED FILE — do not edit by hand.
     由 `pnpm docs:gen` 从代码与下面的 notes 文件生成；手改会被 `pnpm docs:check` 判为漂移。
     要改内容：改 notes JSON 或改代码，然后重新生成。 -->

# 配置文件参考

所有用户级配置集中在 `~/.volto/config.json`（可用 `VOLTO_CONFIG_DIR` 改目录）。

分区形状不一：多数是对象（`preferences`、`providers`、`permissions`、`egress`、`lsp`、`hooks`、`sidebar`），`projects` 与 `routingTiers` 是数组。校验强度也不一：

- `egress` / `permissions` / `lsp` / `hooks`：未知键会让网关**拒绝启动**（拼错等于明确报错，这是有意的）。
- `preferences` / `sidebar`：未知键被忽略，非法值回落到默认。
- **顶层分区名写错不会报错**：那一段配置只是不生效。改完请用界面或接口确认真的生效了。

怎么改、什么时候生效、改坏了怎么办，见 [权限与审批](../guides/permissions-and-approvals.md) 与 [模型与供应商](../guides/models-and-providers.md)；本文只列字段。

## `egress`

网络出口名单。只约束 Network 端口的三个工具（`web_fetch` / `web_search` / `http_query`），不是机器级防火墙——bash 里跑的 curl 不经过它。denylist 优先，精确主机名匹配，无通配符。

| 字段 | 说明 |
| --- | --- |
| `allowHosts` | 允许访问的主机名列表。**一旦写了这个字段就进入白名单模式**：不在名单里的主机全部拒绝；`[]` 表示拒绝全部。 |
| `denyHosts` | 拒绝访问的主机名列表，优先于 allowHosts。 |

## `hooks`

生命周期钩子。每个键是一个生命周期名（`session:start`、`turn:end`、`preToolUse`、`postToolUse`、`userPromptSubmit`、`preCompact`、`subagentStop`、`notification` 等），值是命令钩子数组，每项只接受 `{ "type": "command", "command": "…" }`。


## `lsp`

语言服务器配置。内置只覆盖 TS/JS；其他语言在这里登记。非法配置会拒绝启动，而不是静默失效。

| 字段 | 说明 |
| --- | --- |
| `args` | 启动参数数组。 |
| `command` | 启动命令，例如 `rust-analyzer`。 |
| `initializationParams` | 透传给语言服务器的初始化参数。 |
| `servers` | 按**语言 id** 索引（如 `typescript`、`python`），不是文件扩展名；文件路径先映射到语言 id 再查这张表。 |

## `permissions`

参数级权限规则。数组 `rules`，按顺序匹配，第一条命中生效；规则只能收紧权限，不能越过沙箱边界。

| 字段 | 说明 |
| --- | --- |
| `capability` | 按工具声明的能力匹配。 |
| `commandPrefix` | 命令前缀（逐 token 匹配），只对声明了命令入参的工具生效。 |
| `decision` | 命中后的处置：`allow` / `deny` / `ask`。 |
| `hostPattern` | 按 URL 主机匹配——只对声明了 URL 入参的工具生效。 |
| `pathPattern` | 按路径匹配——只对声明了路径入参的工具生效，`bash` 不在其中。 |
| `rules` | 规则数组。每条规则的字段见下表。 |
| `toolName` | 精确匹配工具名。 |
| `toolPattern` | 按通配模式匹配工具名。 |

## `preferences`

界面的默认值：新会话从哪一档权限开始、用什么语言和主题、标题用哪个模型起名。多数字段在「设置 → 通用设置」里改，手改这个分区通常只在批量重置时用。

| 字段 | 说明 |
| --- | --- |
| `defaultPermissionMode` | 新会话的默认权限档位。 |
| `lastModelId` | 上次用过的模型，用于预选。 |
| `lastProviderId` | 上次用过的供应商，用于预选。 |
| `lastReasoningEffort` | 上次用过的推理强度。 |
| `locale` | 界面语言（zh / en）。 |
| `streamDensity` | 显示模式：detailed（逐个工具成卡）或 concise（每个工具一行）。 |
| `theme` | 主题：light / dark / system。 |
| `titleModelId` | 给新会话起标题所用的模型。 |
| `titleProviderId` | 给新会话起标题所用的供应商；不填则截取首条消息。 |

## `projects`

工作区注册表。数组，每个元素是一项工作区：`id` / `name` / `path` / `createdAt`。日常通过界面添加，不建议手改。


## `providers`

模型供应商与各自的模型清单。apiKey 加密后存在 `apiKeyEnc`，明文不落盘、也不出现在任何接口响应里。

| 字段 | 说明 |
| --- | --- |
| `apiKeyEnc` | 加密后的密钥。手填明文无效。 |
| `auth` | 自定义鉴权方式（少量供应商需要）。 |
| `baseURL` | 覆盖目录里的地址；null 表示用默认。 |
| `headers` | 自定义请求头。 |
| `id` | 供应商在本机的唯一 id。 |
| `kind` | `catalog`（内置目录，按模型 code 选）或 `custom`（自定义 OpenAI 兼容端点）；早期记录可能没有这个字段，读时按 `custom` 处理。 |
| `modelCodes` | 早期写法：只存模型 code 的数组。读取时会转成 `models`，新写入用 `models`。 |
| `models` | 模型清单：每项有 `code`，可选 `name` / `contextWindow` / `maxOutputTokens` / `reasoning` / `input` / `protocol`。 |
| `name` | 显示名。 |
| `piProvider` | catalog 供应商对应的内置目录标识。 |
| `protocol` | 该供应商默认的线上协议（可被单个模型覆盖）。 |

## `routingTiers`

模型路由档位表。数组，每项为 `{ id, label, description, target: { providerId, modelId } | null, reasoningEffort? }`；`target` 为 null 表示未指派，派发时退回父会话的模型。


## `sidebar`

侧边栏布局（置顶会话、分组）。运行时状态，由界面写入，手改会在下次布局变更时被覆盖。

