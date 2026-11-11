---
title: 模型与供应商
type: guide
source:
  - apps/headless-server/src/config/providers.ts
  - apps/headless-server/src/config/routing-tiers.ts
  - apps/web/components/settings*
generated: false
verified: 2026-11-11
---

# 模型与供应商

> 读完你会：配好供应商、理解模型路由档位，并能判断「模型没响应该怪哪一层」。

## 供应商的两种类型

| 类型 | 什么时候用 | 需要填什么 |
| --- | --- | --- |
| 内置目录（catalog） | 厂商在目录里（Anthropic、OpenAI 及主流兼容厂商） | API Key；模型从目录选，能力（上下文窗口、是否支持图片/推理）自动带出 |
| 自定义（custom） | 自建网关、私有部署、目录里没有的 OpenAI 兼容端点 | base URL、API Key、模型 ID，能力字段需要自己填 |

自定义类型的模型 ID 就是你端点接受的那个字符串；内置目录类型里选的是目录自己的模型 code。

## 密钥怎么存

- API Key **加密后**写在 `~/.volto/config.json` 的 `providers` 分区（`apiKeyEnc`）。
- 任何接口响应都不会返回明文；唯一的例外是网关内部构建模型连接时读一次。
- 所以：**手改 `apiKeyEnc` 写明文无效**，加新供应商请走界面或 `POST /providers`。

## 模型字段

| 字段 | 作用 | 不填时 |
| --- | --- | --- |
| `contextWindow` | 上下文窗口大小，决定用量条与压缩时机 | 用量条不显示百分比 |
| `maxOutputTokens` | 单次调用最多生成多少 token | 用provider 的默认值 |
| `reasoning` | 这个模型是否支持推理/思考 | 视为不支持 |
| `input` | 输入模态，例如只收文本 | 未知：不据此隐藏功能 |
| `protocol` | 该模型走哪种线上协议 | 跟随供应商的默认 |

## 模型路由档位

「设置 → 模型路由」里可以定义若干档位（出厂模板是 premium / fast / economy），每档指向一个「供应商 + 模型」。给子代理派任务时可以指定用哪一档。

- **档位没指派目标**（target 为 null）不是错误——派发时退回父会话正在用的模型。
- 删除一个仍被子代理引用的档位会被拒绝（409），先改子代理再删。

## 连通性探测

供应商卡片上有「探测」按钮：用当前配置真的发一次最小请求，报错会直接显示在卡片上。换 Key、改 base URL 之后先探测一次，比在对话里撞错误快。

## 起标题用什么模型

「设置 → 通用设置 → 标题模型」可以指定一个便宜的小模型专门给新会话起标题。不选则直接截取首条消息。

## 出问题怎么办

- **401 / 403** → Key 无效或没有该模型的权限；先点探测。
- **404 / 模型不存在** → 自定义供应商的模型 ID 拼错，或内置目录里该模型 code 变了。
- **回复很慢或立刻截断** → 检查 `contextWindow` 与 `maxOutputTokens` 是否填得比实际小。
- **图片发不出去 / 模型说看不到图** → 该模型的 `input` 没声明图片，或被显式声明成只收文本。

字段全集见 [配置文件参考](../reference/config.md)。