# 网页搜索配置（设置 → 工具配置）设计

- 日期：2026-11-18
- 状态：待评审
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
- 每次调用级别的 `need_content` 开关（本期只按配置决定是否取正文）。
- SearXNG 等自建搜索的专门协议。

## 3. 现状（改动前的真实行为）

- `createWebSearchTool(network, { apiUrl?, apiKey? })`：GET `${apiUrl}?q=&count=`，无 key 时只发 `Accept`；返回 `response.body` 原文。
- 装配点三处：`packages/sdk/src/create-agent.ts`（adapterTools）、`createNetworkToolExecutor({ network })`、子代理继承 `{ ...opts, network }`；`packages/runtimes/node/src/network-tool-executor.ts` 同样硬编码。
- 网关在 `apps/gateway/src/wiring.ts` 每次「会话构建」读取配置（egress / permissions / lsp / hooks 都是这个纪律），构建出的 agent 沿用同一份选项直到下次重建。
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
  snippet?: string;   // 短摘要（列表用）
  summary?: string;   // 长摘要（给模型读）
  siteName?: string;
  publishedAt?: string; // RFC 3339
  content?: string;   // 正文，仅 needContent 时
}

export interface SearchRequestOptions {
  apiKey?: string;
  baseUrl?: string;
  needContent?: boolean;
  count: number;
}

export interface SearchAdapter {
  id: WebSearchSourceId;
  /** 纯函数：请求如何拼。 */
  buildRequest(query: string, opts: SearchRequestOptions): NetworkRequest;
  /** 纯函数：响应如何解析；非 2xx / 结构不符时抛 SearchAdapterError。 */
  parseResponse(resp: NetworkResponse, opts: SearchRequestOptions): SearchHit[];
}
```

- `deepseek.ts`：`POST {baseUrl ?? "https://api.deepseek.com"}/v1/tools/search`，头 `Authorization: Bearer <key>` + `Content-Type: application/json`，body `{ query, count, need_content }`；解析 `results[]` 的 `title/url/snippet/summary/content/site_name/date`。
- `brave.ts`：保留现有 GET 形态（`q`、`count`、`X-Subscription-Token`、`Accept: application/json`）；解析 `web.results[]` 的 `title/url/description`（`description` → snippet）。
- `keyless.ts`：免 key 默认源。先试 `https://html.duckduckgo.com/html/?q=`，HTML 里抓 `result__a` / `result__snippet`；为 0 条或非 2xx 时再试 `https://lite.duckduckgo.com/lite/?q=`。用小型正则提取器（tools 层不引入解析依赖）。
- `index.ts` 导出 `resolveSearchAdapter(id)` 与 `SEARCH_ADAPTERS`。
- `web-search.ts` 改为：`createWebSearchTool(network, opts?: WebSearchOptions)`，其中
  `WebSearchOptions = { source?: WebSearchSourceId; apiKey?: string; baseUrl?: string; needContent?: boolean; /** 兼容旧参 */ apiUrl?: string; }`。
  未给 `source` 时按 `apiUrl ? "brave" : "keyless"` 解析（旧的 `apiUrl/apiKey` 仍可用，等价于 brave + 自定义 baseUrl）。
- 工具输出：
  - `modelContent`：编号列表 `1. title — url\n   date · site\n   summary/snippet`，总长截到 4000 字符并声明截断；0 条时返回「没有匹配结果」。
  - `displayMetadata.webSearch`：`{ source, query, count, durationMs, status?, hits: SearchHit 的前 10 条（snippet/summary 各截 240 字符，不含 content） }`。
  - 失败：`isError: true`，文案分三类——鉴权类（401/403）、网络/服务类、未配置/不可用（含「打开 设置 → 工具配置 → 网页搜索」指引）。
- 工具 schema 与权限不变（`query`、`numResults`；`riskTier: READ_ONLY`、`trust: untrusted`、`requires: [CAP_NETWORK_FETCH]`）。`description` 补一句：支持 `site:` / `lang:` / `after:` 等搜索语法（DeepSeek），源由用户配置决定。

### 5.2 配置：`config.json` 的 `webSearch` 段（网关）

```json
{
  "webSearch": {
    "source": "auto",
    "apiKeyEnc": "v1:...",
    "sourceProviderId": "deepseek-official",
    "baseUrl": "https://api.deepseek.com",
    "needContent": false
  }
}
```

- `source`：`"auto" | "deepseek" | "brave" | "keyless" | "off"`，缺省与缺段都视为 `auto`。
- `apiKeyEnc`：自己填的 key（`createCipher` 加密；PUT 时明文进、出配置只留密文）。
- `sourceProviderId`：复用哪条模型渠道的 key（catalog provider 的 id）。与 `apiKeyEnc` 互斥，`sourceProviderId` 优先。
- `baseUrl`：可选覆盖（自建/代理的 DeepSeek 兼容端点，或 brave 代理）。
- `needContent`：DeepSeek 是否取正文，默认 false。
- 校验：未知键报错（与 egress/browser 一致）；`source` 非法值报错；`sourceProviderId` 指向不存在的渠道 → 读取时降级为 keyless 并在设置页显示警告（不 fail-closed：搜索不是安全边界）。
- 新增文件 `apps/gateway/src/config/web-search.ts`：`loadWebSearchConfig(configDir)`（校验）、`readWebSearchSettingsView(configDir)`（掩码 + 候选渠道列表）、`updateWebSearchConfig(configDir, input)`、`testWebSearch(configDir, query)`。
- `store.ts` 的 `ConfigSection` 增加 `"webSearch"`。
- 复用渠道 key：`createProviderStore().readApiKey(providerId)` 新方法（内部 `cipher.decrypt`），**仅供服务端**，不进任何 HTTP 响应。

### 5.3 解析：`auto` 的退化顺序（wiring 每次会话构建时执行）

1. `source === "off"` → 不给 SDK 传 `webSearch`，并让 `web_search` 从可见工具里消失（不传 adapter 选项 → createAgent 不装配该工具）。
2. `source === "deepseek"` → 有 `sourceProviderId` 用之（key + 该渠道 `baseURL` 派生搜索端点）；否则用 `apiKeyEnc` + `baseUrl`；两样都缺 → keyless + 警告。
3. `source === "brave"` / `"keyless"` → 直接对应适配器。
4. `source === "auto"`（默认）：
   - a. 会话模型渠道是 DeepSeek（`piProvider === "deepseek"` 或 baseURL 主机是 `api.deepseek.com`）且该渠道有 key → deepseek，用这把 key，端点从该渠道 baseURL 派生。
   - b. 否则 keyless。
   - c. `c` 不成立时 keyless 也失败 → 工具报错指引配置。
5. 结果以纯数据交给 SDK：`{ source, apiKey?, baseUrl?, needContent? }`。key 只在进程内存里，不进事件、不进日志、不进 displayMetadata。

「跟随模型」的粒度是会话的默认模型渠道（`wiring.ts` 的 `opts.providerId`）；走路由档位的单次派发不改变搜索源——本期的已知简化，写进文档。

### 5.4 SDK 透传

- `createAgent` 新选项 `webSearch?: { source: WebSearchSourceId; apiKey?: string; baseUrl?: string; needContent?: boolean }`。
- 三处装配点统一用它：`adapterTools.push(createWebSearchTool(network, opts.webSearch))`、`createNetworkToolExecutor({ network, webSearch })`（`packages/runtimes/node` 同步签名）、子代理经 `{ ...opts, network }` 自动继承。
- 行为变化：不传 `webSearch` 时默认 `keyless`（原先默认 brave 无 key）。

### 5.5 网关 HTTP 与设置页

- `GET /config/web-search` → `{ source, apiKeyMasked, sourceProviderId, baseUrl, needContent, candidates: [{ id, name, piProvider, apiKeyMasked }], warning? }`。
- `PUT /config/web-search` → 接受 `{ source, apiKey?: string | null, sourceProviderId?: string | null, baseUrl?: string | null, needContent?: boolean }`；`apiKey` 传空串/null 表示清除；返回同 GET。
- `POST /config/web-search/test` → `{ query?: string }`（默认 "DeepSeek"），用与 agent 相同的解析结果跑一次搜索，返回 `{ source, durationMs, hits } | { error }`。密钥不出服务端。
- `apps/web/lib/config-api.ts` 增加 `fetchWebSearchSettings / updateWebSearchSettings / testWebSearch`。
- `ToolsPanel` 新增卡片「网页搜索」（放在浏览器卡片上方）：
  - 搜索源 select：自动（跟随模型）/ DeepSeek / Brave / 免 key 默认 / 关闭。
  - DeepSeek 展开：鉴权方式二选一（填写 API Key / 复用模型渠道）；填 key 输入框显示掩码提示「已保存 ••••1234」；复用渠道为下拉（候选 = `candidates`，为空时提示先去模型配置添加 DeepSeek 渠道）。
  - 高级（折叠）：`baseUrl` 覆盖、`needContent` 开关。
  - 「测试搜索」按钮 + 结果列表（前 3 条标题+链接，或错误）。
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

  与 `fileChange` 同款处理：从 `tool_result` 事件的 `displayMetadata.webSearch` 提取，投影到 `ConversationToolCall.search`（不经 HTTP 额外请求，重放与刷新后一致）。
- `apps/web/lib/tool-summary.ts`：`web_search` 摘要带条数，如 `"deepseek · query（5 条）"`。
- `ToolCallCard`：对有 `search` 的调用渲染结构化详情——源与耗时徽标、query、逐条「标题（链接）— 摘要 — 日期」，条数多时折叠。原始参数区仍保留。
- 轨迹行（`TrajectoryRow`）沿用现有 `summary` + `durationMs`，不新增列。

### 5.7 文档

- `docs/user/reference/config-sections.json` 新增 `webSearch` 段（中英），说明源与密钥、生效时机。
- `docs/user/reference/tool-notes.json` 更新 `web_search` 描述（按配置走哪个源、失败提示）。
- `docs/user/using/guides/web-search.md`（中英）+ README 索引条目：怎么配、怎么测、auto 的退化顺序、egress 需要放行 `api.deepseek.com` / `html.duckduckgo.com` / `lite.duckduckgo.com` / `api.search.brave.com`。
- 生成页由 `pnpm docs:gen` 产出，`pnpm docs:check` 作为门。

## 6. 测试

- `packages/tools`：三个适配器的请求拼装与响应解析（DeepSeek 用文档示例响应；Brave 用录制 JSON；keyless 用录制 HTML）；非 2xx、结构不符、0 条、超长截断；旧 `apiUrl/apiKey` 兼容。
- `packages/sdk`：`webSearch` 透传到工具与 network executor；子代理继承；`off` 时工具不在可见集合。
- `apps/gateway`：`web-search` 配置读写/掩码/校验；`auto` 解析矩阵（模型渠道是/不是 DeepSeek、渠道无 key、providerId 失效）；路由 GET/PUT/test。
- `packages/core`：`displayMetadata.webSearch` → `ConversationToolCall.search` 投影（含缺失字段、重放一致）。
- `apps/web`：ToolsPanel 渲染与保存、测试按钮成功/失败、工具摘要、ToolCallCard 结构化详情。
- 门禁：`pnpm turbo run typecheck lint test --filter @voltojs/tools --filter @voltojs/sdk --filter @voltojs/core --filter <gateway> --filter <web>`（排除 desktop-app），再 `pnpm turbo run build` + `pnpm docs:check`。

## 7. 风险与已知限制

- **免 key 源依赖抓取**：DuckDuckGo HTML 无 SLA、可能反爬。缓解：html → lite 两级兜底、失败即明确报错、fixture 测试、文档写明「生产建议配 DeepSeek 或 Brave」。
- **密钥复用是隐式的**：auto 会拿模型渠道的 key 去调搜索接口；只在内存使用、不落盘、不出服务端，但文档要写明这一点。
- **Brave 映射靠文档**：本环境无法联网核对，实现时用录制 fixture 锁定；若线上结构与预期不同，只需改一个适配器文件。
- **生效时机**：每个会话构建时读配置；已建会话要等下次重建（切模型/重启网关）。设置页文案如实写。
- **egress**：若用户配了 `egress` 允许名单，忘记放行搜索主机时工具会失败——报错文案里点名要放行的主机。

## 8. 交付顺序（供写计划参考）

1. tools/web 适配器 + 工具改造（含单测）。
2. core 投影字段 + sdk 透传。
3. gateway 配置读写 + auto 解析 + 路由。
4. web 设置页 + 轨迹展示。
5. 文档与 `docs:gen`/`docs:check`，全量门禁与手工验收（真 key 跑一次搜索、未配置跑一次默认源、轨迹里看到逐条结果）。
