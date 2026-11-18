# 网页搜索配置（设置 → 工具配置）设计

- 日期：2026-11-18
- 状态：待评审（已过一轮 builder check）
- 作用范围：`@voltojs/tools`（web）、`@voltojs/core`（视图投影）、`@voltojs/sdk`、`apps/gateway`、`apps/web`、`docs/user`

## 1. 目标与动机

网关里的 `web_search` 今天是个半残工具：`packages/tools/src/web/web-search.ts` 硬编码 Brave 端点 + `X-Subscription-Token`，
SDK 的 `apiUrl`/`apiKey` 选项网关从不传。结果是 agent 在会话里调用 `web_search` 几乎必然失败，用户也没有任何地方可以配置它。

要做的事：

1. 「设置 → 工具配置」新增「网页搜索」卡片：搜索源可切换（自动 / DeepSeek / Brave / 免 key 默认 / 关闭）。
2. DeepSeek 源支持两种鉴权：自己填 API Key，或复用「模型配置」里某条渠道的 Key；渠道有多条时由用户显式选择。
3. 未配置时也要能搜：默认按「当前会话模型所属渠道」退化，以模型能力为主。
4. 对话轨迹里详细展示搜索过程（源、query、命中条数、耗时、逐条标题/链接/摘要/日期），而不是把一段 JSON 甩给用户。

## 2. 目标 / 非目标

**目标**

- 搜索协议知识只有一份，放在 `@voltojs/tools/web`，可单测、可被 SDK 用户复用。
- 配置持久在 `~/.volto/config.json` 的 `webSearch` 段；密钥加密（复用 `createCipher`），HTTP 只返回掩码。
- 设置页可「测试搜索」，当场看到结果或错误。
- 未配置时 degraded 但不静默：走默认源；全部失败时工具返回可执行的报错（指向设置页），而不是空结果。
- 轨迹结构化展示搜索过程。

**非目标（本期不做）**

- 供应商原生搜索（Anthropic `web_search` server tool、DeepSeek 联网工具）——仓库里目前只有事件归一化，没有接线，属独立特性。
- DeepSeek Fetch 接口 / 把 `web_fetch` 也接到供应商。
- 通用「自定义端点模板」（URL + 方法 + 头 + body 模板 + 结果 JSONPath）；以后可作为第四个适配器加入，不影响本期结构。
- `need_content`（DeepSeek 正文）开关：本期固定 `need_content: false`，只取 summary/snippet（决策 D-5）。
- 每次调用级别的搜索参数（条数、正文、语言）——仍是工具入参 `numResults` 一个。
- SearXNG 等自建搜索的专门协议。

## 3. 现状（改动前的真实行为）

- `createWebSearchTool(network, { apiUrl?, apiKey? })`：GET `${apiUrl}?q=&count=`，无 key 时只发 `Accept`；返回 `response.body` 原文。
- 装配点三处：`packages/sdk/src/create-agent.ts`（adapterTools）、`createNetworkToolExecutor({ network })`、子代理继承 `{ ...opts, network }`；`packages/runtimes/node/src/network-tool-executor.ts` 同样硬编码。今天只要传了 `network` 就无条件注册 `web_search`。
- 网关在 `apps/gateway/src/wiring.ts` 每次「会话构建」读取配置（egress / permissions / lsp / hooks 都是这个纪律），构建出的 agent 沿用同一份选项直到下次重建。会话的模型渠道由 `opts.providerId` 带给 wiring；新会话默认渠道是 `preferences.lastProviderId`。
- 轨迹链路：`ToolResult.displayMetadata` → `tool_result` 事件 → `view-projection` 产生 `ConversationToolCall`（目前只挑出 `fileChange` 等少数结构化字段）与 `TrajectoryRow`；`apps/web/lib/tool-summary.ts` 出一行摘要，`ToolCallCard` 展开参数与输出。
- 密钥：`apps/gateway/src/config/crypto.ts` 的 `createCipher(dir)`；provider 记录里是 `apiKeyEnc`，`createProviderStore().resolveModel()` 是唯一解密出口（只给服务端构建 ModelPort 用）。
- 配置节：`apps/gateway/src/config/store.ts` 的 `ConfigSection`（`LEGACY_FILES` 的键 + `sidebar`）。新增 `webSearch` 与 `sidebar` 同款：无 legacy 文件、直接作为新键加入联合类型。

## 4. 方案取舍（已定）

选择「搜索源适配器放在 `@voltojs/tools/web`，配置在网关，选项经 SDK 透传」。

- 备选 B（网关自造工具）：改动小，但 SDK 用户拿不到、两套实现会漂、覆盖内部装配仍需改 SDK。
- 备选 C（只做通用端点模板）：一次覆盖任意 API，但设置页要暴露模板字段、DeepSeek 的 `summary`/`content`/`date`/`authority` 映射别扭、「测试搜索」难做有意义的校验。
- 选 A 的理由：需求本质是「几种已知协议 + 一个可扩展点」，协议收在 tools 最干净；C 以后可以作为第四个适配器加入。

## 5. 设计

### 5.1 工具层：搜索源适配器（`packages/tools/src/web/search/`）

```ts
export type WebSearchSourceId = "deepseek" | "brave" | "keyless";

export interface SearchHit {
  title: string;
  url: string;
  snippet?: string;   // 短摘要（列表与轨迹用）
  summary?: string;   // 长摘要（给模型读）
  siteName?: string;
  publishedAt?: string; // RFC 3339
}

export interface SearchRequestOptions {
  apiKey?: string;
  baseUrl?: string;
  count: number;
}

/** 一次尝试：一个请求 + 一个解析。多阶段（keyless 的 html→lite）用数组表达。 */
export interface SearchAttempt {
  label: string;
  request(query: string, opts: SearchRequestOptions): NetworkRequest;
  parse(resp: NetworkResponse, opts: SearchRequestOptions): SearchHit[];
  /** 该尝试 0 条或非 2xx 时是否继续下一个尝试（keyless 为 true）。 */
  retryOnEmpty?: boolean;
  retryOnError?: boolean;
}

export interface SearchAdapter {
  id: WebSearchSourceId;
  /** 纯函数：有序尝试列表。 */
  attempts(query: string, opts: SearchRequestOptions): SearchAttempt[];
}
```

决策：

- **D-8 多阶段接口**：用 `attempts[]` 而不是单 `buildRequest/parseResponse`，keyless 的 html→lite 兜底是第一等公民，解析仍然是纯函数、可单测。
- **D-3 baseUrl 语义（必须精确，猜错 404）**：
  - DeepSeek：`baseUrl` 是 **API 基址，可带可不带 `/v1`**。规整 = trim → 去尾斜杠 → 若以 `/v1` 结尾则去掉；端点 = `{base}/v1/tools/search`。缺省 `https://api.deepseek.com`。
  - Brave：`baseUrl` 是 **origin**（如 `https://api.search.brave.com`）；端点 = `{origin}/res/v1/web/search`。缺省用 origin。
  - 旧 SDK 参数 `apiUrl` 语义不变：**完整端点**，只用于 Brave 适配器（`apiUrl` 出现即视为 brave 且不再拼路径）。`apiKey` 仍可用。
  - 从模型渠道派生（auto / 复用渠道）：渠道 baseURL 常见 `https://api.deepseek.com` 或 `.../v1`，按上面同一规整函数处理。
- `deepseek.ts`：`POST {base}/v1/tools/search`，`Authorization: Bearer <key>` + `Content-Type: application/json`，body `{ query, count, need_content: false }`；解析 `results[]` 的 `title/url/snippet/summary/site_name/date`。query 超 128 字符时截断并在 `modelContent` 里声明。
- `brave.ts`：GET，`q`、`count`、`X-Subscription-Token`、`Accept: application/json`；解析 `web.results[]` 的 `title/url/description`（`description` → snippet）。
- `keyless.ts`：免 key 默认源。attempt 1 = `https://html.duckduckgo.com/html/?q=`（`result__a` / `result__snippet`，跳转链接解 `uddg` 参数）；attempt 2 = `https://lite.duckduckgo.com/lite/?q=`（`a.result-link` + `td.result-snippet`）。带桌面 UA 头。两次都空/失败 → `SearchAdapterError("keyless_unavailable")`。正则提取，不引入解析依赖。
- `index.ts` 导出 `resolveSearchAdapter(id)` 与 `SEARCH_ADAPTERS`。
- `web-search.ts`：`createWebSearchTool(network, opts?: WebSearchOptions)`，`WebSearchOptions = { source?: WebSearchSourceId; apiKey?: string; baseUrl?: string; /** 兼容旧参 */ apiUrl?: string }`。
  解析规则：`source` 缺省时 `apiUrl ? "brave" : "keyless"`。
- 工具输出：
  - `modelContent`：编号列表 `1. title — url\n   date · site\n   summary/snippet`，总长截到 4000 字符并声明截断；0 条时返回「没有匹配结果」。
  - `displayMetadata.webSearch`：`{ source, query, count, durationMs, status?, hits: 前 10 条（snippet/summary 各截 240 字符） }`。
  - 失败：`isError: true`，三类文案——鉴权（401/403，指向设置页对应源）、网络/服务（含 status）、不可用（keyless 双端失败 / 未配置，指向「设置 → 工具配置 → 网页搜索」；若 egress 拒绝则点名要放行的主机）。
- **D-5 不引入 `needContent`**：`SearchHit` 无 `content` 字段，DeepSeek 固定 `need_content: false`。需要正文的场景今天已有 `web_fetch`，不在这里重复实现一个「抓了不消费」的字段。
- 工具 schema 与权限不变（`query`、`numResults`；`riskTier: READ_ONLY`、`trust: untrusted`、`requires: [CAP_NETWORK_FETCH]`）。`description` 补一句：搜索源由用户配置决定，支持 `site:` / `lang:` / `after:` 等语法（透传给搜索服务）。

### 5.2 配置：`config.json` 的 `webSearch` 段（网关）

**D-2 按源分槽存 key，绝不复用同一个 key 跨主机。**

```json
{
  "webSearch": {
    "source": "auto",
    "deepseek": { "apiKeyEnc": "v1:...", "sourceProviderId": null, "baseUrl": null },
    "brave": { "apiKeyEnc": "v1:...", "baseUrl": null }
  }
}
```

- `source`：`"auto" | "deepseek" | "brave" | "keyless" | "off"`；缺段或缺失视为 `auto`。
- `deepseek.apiKeyEnc`：自己填的 key（`createCipher` 加密）。`deepseek.sourceProviderId`：复用哪条模型渠道（catalog provider id），与 `apiKeyEnc` 互斥、优先。
- `*.baseUrl`：可选覆盖，语义见 D-3。
- 校验分级（**D-6**）：
  - **写入端严格**：PUT 拒绝未知键、非法 `source`、非法 URL、非 DeepSeek 渠道 id → 400。
  - **读取端宽松**：`loadWebSearchConfig` 不抛错，返回 `{ config, warnings[] }`。拼错只是让搜索退化，不该让所有会话建不起来（对比 egress：那是安全边界，必须 fail-closed）。warnings 同时进 wiring 日志与 GET 视图。
- `sourceProviderId` 指向不存在的渠道 → 降级 keyless + warning（不阻断）。
- 新增 `apps/gateway/src/config/web-search.ts`：`loadWebSearchConfig`、`readWebSearchSettingsView`（掩码 + 候选渠道 + warnings）、`updateWebSearchConfig`、`testWebSearch`、`resolveWebSearch`（纯解析，见 §5.3）。
- `store.ts` 的 `ConfigSection` 增加 `"webSearch"`。
- 复用渠道 key：`createProviderStore().readApiKey(providerId)` 新方法（内部 `cipher.decrypt`），**仅供服务端**，不进任何 HTTP 响应。
- **D-7 候选渠道**：`piProvider === "deepseek"` 或 baseURL 主机以 `deepseek.com` 结尾的渠道。其它渠道不进候选，PUT 也拒绝——不把无关服务的 key 发往搜索主机。

### 5.3 解析：`auto` 的退化顺序

在 wiring 每次会话构建时执行，产出纯数据 `{ source, apiKey?, baseUrl? }`（key 只在进程内存里，不进事件、日志、displayMetadata）。

1. `source === "off"` → 不装配 `web_search`（模型看不到该工具；**D-1**：不是“看得到但报错”）。
2. `source === "deepseek"` → `sourceProviderId` 有值用其 key + 渠道 baseURL 派生端点；否则用 `deepseek.apiKeyEnc` + `deepseek.baseUrl`；两样都缺 → keyless + warning。
3. `source === "brave"` → `brave.apiKeyEnc`（缺失则工具报鉴权错误，仍装配）+ `brave.baseUrl`。
4. `source === "keyless"` → keyless。
5. `source === "auto"`（默认）：
   - a. 会话模型渠道是 DeepSeek（`piProvider === "deepseek"` 或 baseURL 主机以 `deepseek.com` 结尾）且该渠道有 key → deepseek，复用这把 key，端点从该渠道 baseURL 派生。
   - b. 否则 keyless。
6. 「跟随模型」的粒度是会话默认模型渠道（`wiring.ts` 的 `opts.providerId`）；走路由档位的单次派发不改变搜索源——本期的已知简化，写进文档。

### 5.4 SDK 透传

- `createAgent` 新选项 `webSearch?: { source: WebSearchSourceId | "off"; apiKey?: string; baseUrl?: string }`。
- **D-1 关闭语义**：`webSearch.source === "off"` → 三处装配点都不注册 `web_search`，模型看不到它（与「port 缺失则工具自动消失」同一纪律）。**不传 `webSearch` → 默认 keyless**（现状不传 = brave 无 key 必失败，这是有意的行为替换）。
- 三处装配点统一：`adapterTools.push(createWebSearchTool(network, opts.webSearch))`、`createNetworkToolExecutor({ network, webSearch })`（`packages/runtimes/node` 同步签名）、子代理经 `{ ...opts, network }` 自动继承（`networkExecutor` 同样用 `opts.webSearch`）。
- 不用 `toolVisibility`：它按 group 关，会把 `web_fetch`/`http_query` 一起关掉。

### 5.5 网关 HTTP 与设置页

- `GET /config/web-search` → `{ source, deepseek: { apiKeyMasked, sourceProviderId, baseUrl }, brave: { apiKeyMasked, baseUrl }, candidates: [{ id, name, apiKeyMasked }], warnings: string[] }`。
- `PUT /config/web-search` → `{ source, deepseek?: { apiKey?: string | null, sourceProviderId?: string | null, baseUrl?: string | null }, brave?: { apiKey?: string | null, baseUrl?: string | null } }`；`apiKey` 传 null/空串 = 清除。严格校验（D-6）。
- `POST /config/web-search/test` → `{ query?: string; providerId?: string }`（query 缺省 `"DeepSeek"`）。**D-4**：`auto` 下测试与「新建一个会话」用同一套解析——渠道取 `providerId` 入参，缺省 `preferences.lastProviderId`；网络用 `createNodeNetwork()` 且套 `wrapNetworkWithEgress(egressPolicy)`，与 agent 完全同一条路径，避免「测试通过、agent 失败」。响应 `{ resolved: { source, reason }, durationMs, hits }` 或 `{ error, resolved }`。密钥不出服务端。
- `apps/web/lib/config-api.ts` 增加 `fetchWebSearchSettings / updateWebSearchSettings / testWebSearch`。
- `ToolsPanel` 新增卡片「网页搜索」（浏览器卡片上方）：
  - 搜索源 select：自动（跟随模型）/ DeepSeek / Brave / 免 key 默认 / 关闭。
  - 选 DeepSeek 时：鉴权方式二选一（填写 API Key / 复用模型渠道）；key 输入框显示掩码提示「已保存 ••••1234」；复用渠道为下拉（候选为空时提示去模型配置添加 DeepSeek 渠道）。
  - 选 Brave 时：只显示 Brave 自己的 key 槽（与 DeepSeek 的 key 互不通用）。
  - 高级（折叠）：对应源的 `baseUrl` 覆盖。
  - 「测试搜索」按钮 + 结果（前 3 条标题+链接，或错误；结果里显示实际解析到的源）。
  - warnings 以一行提示展示（如「渠道已不存在，已退回免 key 默认源」）。
  - 保存提示：新建会话生效；已有会话在下次重建时生效（不写「重启网关」）。
  - 全部文案进 `apps/web/messages/{zh,en}/settings.json` 的 `tools.*`。

### 5.6 轨迹展示

- 在 `packages/core/src/view-projection.ts` 定义窄类型：

```ts
export interface WebSearchReport {
  source: string;
  query: string;
  count: number;
  durationMs?: number;
  status?: number;
  hits: Array<{ title: string; url: string; snippet?: string; summary?: string; siteName?: string; publishedAt?: string }>;
}
```

  与 `fileChange` 同款处理：从 `tool_result` 事件的 `displayMetadata.webSearch` 提取，投影到 `ConversationToolCall.search`（重放与刷新后一致，不需要额外请求）。
- `apps/web/lib/tool-summary.ts`：`web_search` 摘要带条数，如 `"deepseek · query（5 条）"`；无结果时为 `"query（0 条）"`。
- `ToolCallCard`：对有 `search` 的调用渲染结构化详情——源与耗时徽标、query、逐条「标题（链接）— 摘要 — 日期」，超过 5 条折叠。原始参数区仍保留。
- 轨迹行（`TrajectoryRow`）沿用现有 `summary` + `durationMs`，不新增列。

### 5.7 文档

- `docs/user/reference/config-sections.json` 新增 `webSearch` 段（中英），说明源、密钥分槽、生效时机。
- `docs/user/reference/tool-notes.json` 更新 `web_search` 描述（按配置走哪个源、失败提示）。
- `docs/user/using/guides/web-search.md`（中英）+ README 索引条目：怎么配、怎么测、auto 的退化顺序、egress 需要放行 `api.deepseek.com` / `html.duckduckgo.com` / `lite.duckduckgo.com` / `api.search.brave.com`。
- 生成页由 `pnpm docs:gen` 产出，`pnpm docs:check` 作为门。

## 6. 测试

- `packages/tools`：三个适配器的 request/parse（DeepSeek 用文档示例响应；Brave 用录制 JSON；keyless 用**合成 HTML fixture**，见 §7 风险 1）；非 2xx、结构不符、0 条、尝试兜底（html 空 → lite 命中）、超长截断、旧 `apiUrl/apiKey` 兼容、`source: "off"` 不装配。
- `packages/sdk`：`webSearch` 透传到工具与 network executor；子代理继承；`off` 时 `web_search` 不在可见集合；不传时默认 keyless。
- `apps/gateway`：`web-search` 配置读写/掩码/严格校验；`auto` 解析矩阵（渠道是/不是 DeepSeek、渠道无 key、providerId 失效、source off）；`sourceProviderId` 拒绝非 DeepSeek 渠道；三条路由；test 路由走 egress 包装。
- `packages/core`：`displayMetadata.webSearch` → `ConversationToolCall.search` 投影（含缺失字段、重放一致）。
- `apps/web`：ToolsPanel 渲染与保存、按源切换显示不同 key 槽、测试按钮成功/失败、工具摘要、ToolCallCard 结构化详情。
- 门禁：`pnpm turbo run typecheck lint test --filter @voltojs/tools --filter @voltojs/sdk --filter @voltojs/core --filter @voltojs/gateway --filter @voltojs/web`（排除 desktop-app），再 `pnpm turbo run build` + `pnpm docs:check`。

## 7. 风险与已知限制

- **免 key 源依赖抓取**：DuckDuckGo HTML 无 SLA、可能反爬；本环境无法联网取样（`curl` 无网络、harness 的 fetch 走 DeepSeek Fetch，DDG 返回 404），fixture 只能合成。缓解：html → lite 两级兜底、失败即明确报错、文档写明「生产建议配 DeepSeek 或 Brave」；真实网络验收由使用者跑一次「测试搜索」。若真实样本结构与假设不同，只需改 `keyless.ts` 一个文件。
- **密钥复用是隐式的**：auto 会拿模型渠道的 key 去调搜索接口；只在内存使用、不落盘、不出服务端，且只在渠道本身是 DeepSeek 时发生（D-7），但文档要写明这一点。
- **Brave 映射靠文档**：本环境无法联网核对，用录制/合成 fixture 锁定；若线上结构不同，只改一个适配器文件。
- **生效时机**：每个会话构建时读配置；已建会话要等下次重建（切模型/重启网关）。设置页文案如实写。
- **egress**：用户配了允许名单却漏放行搜索主机时工具会失败——报错文案点名要放行的主机；test 路由同样走 egress，所以测试结果与 agent 一致。
- **路由档位**：单次派发切到别的模型不改变搜索源（跟随会话默认渠道）。

## 8. 交付顺序（供写计划参考）

1. tools/web 适配器 + 工具改造（含单测）。
2. core 投影字段 + sdk 透传（含 `off`）。
3. gateway 配置读写 + auto 解析 + 三条路由。
4. web 设置页 + 轨迹展示。
5. 文档与 `docs:gen`/`docs:check`，全量门禁与手工验收（真 key 跑一次搜索、未配置跑一次默认源、轨迹里看到逐条结果）。
