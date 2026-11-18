---
title: 配置网页搜索
type: guide
source:
  - packages/tools/src/web/web-search.ts
  - packages/tools/src/web/search
  - apps/gateway/src/config/web-search.ts
  - apps/web/components/settings/WebSearchCard.tsx
verified: 2026-11-18
generated: false
---

# 配置网页搜索

> 读完你会：把 agent 的 `web_search` 接到你自己掌控的搜索服务上，在设置页测通它，并知道什么都不配时会发生什么。

`web_search` 工具不再内置写死的搜索服务。它调用你在**设置 → 工具配置 → 网页搜索**里配置的源；什么都没配时，它返回配置指引，而不是发出一个注定失败的请求。

## 选一个搜索源

- **自动（默认）** —— 跟随会话的模型渠道。如果该渠道是 DeepSeek 且配了 API Key，就直接复用那把 key，走 `https://api.deepseek.com/v1/tools/search`，无需再配。其它渠道在配好搜索源之前会落在「未配置」状态。
- **DeepSeek** —— 同一个端点，鉴权二选一：在这里填 key，或复用某条 DeepSeek 模型渠道的 key。渠道有多条时，在**鉴权方式 → 复用模型渠道**里选。
- **Brave** —— `https://api.search.brave.com/res/v1/web/search`，需要 Brave Search 的订阅 token。
- **GLM** —— `https://open.bigmodel.cn/api/paas/v4/web_search`（`search_std` 引擎），需要智谱的 key。
- **自定义** —— 任何 REST 搜索服务：方法、URL、鉴权头与前缀、额外请求头、请求体模板，以及结果列表和各字段的 JSON 路径。
- **关闭** —— 把 `web_search` 从模型可见的工具集里彻底移除。

每个源各存一份加密的 key。切换搜索源不会把一家的 key 发到另一家的主机。

## 自定义搜索源

一个自定义源就是一次请求。POST 时请求体模板支持两个占位符：

- `{{query}}` —— 已做 JSON 转义的搜索词，引号要自己写，例如 `{"q": "{{query}}", "n": {{count}}}`。
- `{{count}}` —— 期望的条数。

GET 时两个占位符写在 URL 里，按 URL 编码替换。映射字段是响应里的点号路径，例如列表写 `search_result`，字段写 `title` / `link` / `content`。保存时能校验的都会校验——方法、URL、必填映射路径，以及请求体模板能否渲染出合法 JSON；路径是否真的对得上响应，要靠**测试搜索**或第一次调用才见分晓，所以新源请先测再用。

## 测试

**测试搜索**用与「新建会话」完全相同的解析结果、经过同一个 egress 包装的网络端口发一次请求，所以测试通过就意味着 agent 也会通过。选择器上方那行会显示当前实际解析到什么（例如「自动 → 复用 DeepSeek 渠道」）。

## 未配置时

工具仍然可见，每次调用返回：*未配置搜索源；打开 设置 → 工具配置 → 网页搜索 选一个源……*。这是有意的——静默消失的能力，用户永远发现不了。想让它消失就选**关闭**。

## 网络出口

如果你配了 `egress.allowHosts` 允许名单，记得放行搜索主机：`api.deepseek.com`、`api.search.brave.com`、`open.bigmodel.cn` 或你自己的端点；否则工具会报告被拒绝，并点名它需要的主机。

## 什么时候生效

网关在每次会话构建时读取这份配置：新建会话立刻生效，已有会话在下次重建时生效（例如换模型之后）。
