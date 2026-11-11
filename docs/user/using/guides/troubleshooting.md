---
title: 故障排查
type: guide
source:
  - apps/headless-server/src/server.ts
  - apps/headless-server/src/config/store.ts
  - apps/web/lib/sse-client.ts
generated: false
verified: 2026-11-11
---

# 故障排查

> 读完你会：按症状找到原因，而不是靠猜。

## 启动阶段

| 症状 | 原因 | 动作 |
| --- | --- | --- |
| `Cannot find module .../dist/server.js` | 没构建 | `pnpm turbo run build` |
| 启动即报「没有可用的沙箱后端」 | 平台无后端，或 Linux 缺 `bwrap` | 装 `bwrap`；或切「完全」档（无隔离） |
| 启动即报配置损坏 | `config.json` 语法错或字段名拼错 | 修 `~/.volto/config.json`；坏文件会被拒绝而不是忽略 |
| 端口 3100 / 6100 被占用 | 旧进程还在 | 停掉旧进程 |

## 登录与连接

| 症状 | 原因 | 动作 |
| --- | --- | --- |
| 打开页面一直跳登录 | 用了 `http://localhost:3100` 而不是带 `token=` 的链接 | 用网关打印的 `Or open the web app URL` |
| 网关重启后再也进不去 | 一次性 token 变了 | 用新打印的链接重新登录 |
| 消息发出去没有反应 | SSE 断线 | 刷新页面；前端会自动重连，但断线期间的回合需要重发 |
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