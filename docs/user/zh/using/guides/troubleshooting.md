---
title: 故障排查
type: guide
source:
  - apps/gateway/src/server.ts
  - apps/gateway/src/config/store.ts
  - apps/web/lib/sse-client.ts
generated: false
verified: 2026-11-12
---

# 故障排查

> 读完你会：按症状找到原因，而不是靠猜。

## 启动阶段

| 症状 | 原因 | 动作 |
| --- | --- | --- |
| `Cannot find module .../dist/server.js` | 从源码跑但没构建 | `pnpm turbo run build` |
| 启动日志出现 `[sandbox] No sandbox backend available on this platform` | 平台无后端，或 Linux 缺 `bwrap` | Linux 装 `bwrap` 后重启；Windows 目前无解（网关默认档要求隔离） |
| 启动即报配置损坏 | `config.json` 语法错或字段名拼错 | 修 `~/.volto/config.json`；坏文件会被拒绝而不是忽略 |
| 报错 `Could not listen on 127.0.0.1:3100: EADDRINUSE` | 端口（默认 3100）被旧进程占用。此时**不打印**那两行启动信息，标准输出为空，退出码 1 | 停掉旧进程，或换个端口 |

## 登录与连接

| 症状 | 原因 | 动作 |
| --- | --- | --- |
| 打开页面一直跳登录 / 一直 401 | 没有 cookie，且打开的地址不带 `token=` | 用启动时的 `Open:` 链接，或 `npx @voltojs/gateway token` 打印的链接；重启过的旧链接已失效 |
| 网关重启后再也进不去 | 启动 token 每次重启都变（持久 token 不变） | 用新打印的链接，或 `npx @voltojs/gateway token` |
| 消息发出去没有反应 | SSE 断线，或同一段会话在另一个标签页 / 设备上被打开了（一段会话只服务一个连接） | 关掉多余的标签页后刷新；断线期间的回合需要重发 |
| 审批卡一直「等待中」 | 与网关的连接断了 | 刷新后重发该请求 |

## 对话阶段

| 症状 | 原因 | 动作 |
| --- | --- | --- |
| 模型报 401 / 403 | Key 无效或权限不足 | 「设置 → 模型配置」点探测 |
| 模型报 404 / 模型不存在 | 自定义供应商的模型 ID 拼错 | 核对 ID；内置目录换一个模型试试 |
| 回复被截断 | `maxOutputTokens` 太小 | 调大该模型的输出上限 |
| 上下文用量条很快满 | `contextWindow` 填小了，或任务确实长 | 改对窗口大小；用 `/compact` 压缩 |
| 工具调用被拒，报 `Operation not permitted` | 沙箱在按档位拦截 | 换档位或换目录，见 [沙箱与平台](./sandbox-and-platforms.md) |
| 工具调用被拒，报 403 + 主机名 | 网络出口名单拦了 | 改 `egress` 分区的 `allowHosts` |
| 语言服务器调用报 `LSP_SERVER_MISSING` | 没装 `typescript-language-server` | `npm install -g typescript-language-server typescript` |

## 数据在哪

全部运行期数据在 `~/.volto/`：

- `config.json`：用户级配置（供应商、权限、路由、钩子、LSP、egress、偏好）
- `key` / `auth-secret`：加密密钥，**不要删**，删了已存的 Key 就解不开
- 会话库、附件、agents、skills：各自独立目录
- `audit.jsonl`：审计流水

想整体重置：把 `config.json` 改名备份，重启即可回到默认配置（旧的分域配置文件若存在会被重新读取）。**不要**直接删 `~/.volto` 整个目录——那会连会话历史一起丢。