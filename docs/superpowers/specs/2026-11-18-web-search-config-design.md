# 网页搜索配置（设置 → 工具配置）设计

- 日期：2026-11-18
- 状态：待评审（已过 builder check，产品取舍已定：B + 自定义端点源）
- 作用范围：`@voltojs/tools`（web）、`@voltojs/core`（视图投影）、`@voltojs/sdk`、`apps/gateway`、`apps/web`、`docs/user`

## 1. 目标与动机

网关里的 `web_search` 今天是个半残工具：`packages/tools/src/web/web-search.ts` 硬编码 Brave 端点 + `X-Subscription-Token`，
SDK 的 `apiUrl`/`apiKey` 选项网关从不传。结果是 agent 在会话里调用 `web_search` 几乎必然失败，用户也没有任何地方可以配置它。

要做的事：

1. 「设置 → 工具配置」新增「网页搜索」卡片：搜索源可切换——内置 DeepSeek / Brave / GLM，以及用户自己添加的自定义搜索服务。
2. DeepSeek 源支持两种鉴权：自己填 API Key，或复用「模型配置」里某条渠道的 Key；渠道有多条时由用户显式选择。
3. 未配置时以模型能力为主：当前模型渠道是 DeepSeek 就自动复用其 key；否则工具仍可见，但返回可执行的配置指引（不做抓取兜底）。
4. 对话轨迹里详细展示搜索过程（源、query、命中条数、耗时、逐条标题/链接/摘要/日期），而不是把一段 JSON 甩给用户。

## 2. 目标 / 非目标

**目标**

- 搜索协议知识只有一份，放在 `@voltojs/tools/web`，可单测、可被 SDK 用户复用。
- 配置持久在 `~/.volto/config.json` 的 `webSearch` 段；密钥加密（复用 `createCipher`），HTTP 只返回掩码。
- 设置页可「测试搜索」，当场看到结果或错误（内置源与自定义源都测）。
- 未配置时 degraded 但不静默：DeepSeek 渠道自动生效；其它渠道给出指向设置页的明确错误。
- 轨迹结构化展示搜索过程。

**非目标（本期不做）**

- **聊天插件型搜索源**（Qwen `enable_search`、MiMo `tools:[{type:"web_search"}]`、Anthropic server tool）：本质是「再调一次模型」，成本、延迟与轨迹语义都不同，下一期单独设计（见 §4.1）。
- 免 key 的抓取源（DuckDuckGo HTML 等）：主流成熟 agent 都不把它当默认，且无法验收（见 §4.1 / D-9）。
- DeepSeek / GLM 的 Fetch（网页正文）接口；把 `web_fetch` 也接到供应商。
- `need_content` 开关：本期固定 `need_content: false`（D-5）。
- 每次调用级别的搜索参数——仍只有工具入参 `numResults`。
- 自定义源的多引擎/地区/时间范围等厂商特有能力（GLM 的 `search_engine` 固定 `search_std`，用户可在 body 模板里自己写死其它值）。

## 3. 现状（改动前的真实行为）

- `createWebSearchTool(network, { apiUrl?, apiKey? })`：GET `${apiUrl}?q=&count=`，无 key 时只发 `Accept`；返回 `response.body` 原文。
- 装配点三处：`packages/sdk/src/create-agent.ts`（adapterTools）、`createNetworkToolExecutor({ network })`、子代理继承 `{ ...opts, network }`；`packages/runtimes/node/src/network-tool-executor.ts` 同样硬编码。今天只要传了 `network` 就无条件注册 `web_search`。
- 网关在 `apps/gateway/src/wiring.ts` 每次「会话构建」读取配置（egress / permissions / lsp / hooks 都是这个纪律），构建出的 agent 沿用同一份选项直到下次重建。会话的模型渠道由 `opts.providerId` 带给 wiring；新会话默认渠道是 `preferences.lastProviderId`。
- 轨迹链路：`ToolResult.displayMetadata` → `tool_result` 事件 → `view-projection` 产生 `ConversationToolCall`（目前只挑出 `fileChange` 等少数结构化字段）与 `TrajectoryRow`；`apps/web/lib/tool-summary.ts` 出一行摘要，`ToolCallCard` 展开参数与输出。
- 密钥：`apps/gateway/src/config/crypto.ts` 的 `createCipher(dir)`；provider 记录里是 `apiKeyEnc`，`createProviderStore().resolveModel()` 是唯一解密出口（只给服务端构建 ModelPort 用）。
- 配置节：`apps/gateway/src/config/store.ts` 的 `ConfigSection`（`LEGACY_FILES` 的键 + `sidebar`）。新增 `webSearch` 与 `sidebar` 同款：无 legacy 文件、直接作为新键加入联合类型。

## 4. 取舍

### 4.1 调研：成熟 agent 的默认网页搜索（D-9）

| Agent | 默认搜索从哪来 | 未配置时 |
| --- | --- | --- |
| Claude Code | Anthropic 服务端 `web_search`，用模型厂商凭据 | 托管，无此问题 |
| Codex CLI / IDE | Responses API 的 `web_search`（`cached`/`live`/`disabled`） | CLI 默认关、IDE 本地任务默认开 |
| Gemini CLI | `google_web_search`（Google Search grounding） | 托管，无此问题 |
| Amp | Parallel Search（服务端） | 托管 |
| OpenCode | Exa / Firecrawl / Parallel / Tavily / TinyFish，首次搜索让用户选 | 提示选源；`websearch: false` 摘掉工具；`random` 多源 + 429 冷却 |
| OpenHands | Tavily | 无 key 就没有搜索 |
| Cline / Roo | 第三方源或 MCP | 提示配置 |

规律：托管派把搜索做成模型厂商能力；自选派要求用户配置并显式提示；**免 key 抓取只在 MCP/skill 外挂生态里出现，没有成熟 agent 拿它当默认**。
本 harness（DSH）自身也是「从模型供应商 base URL 派生 DeepSeek `/v1/tools/search` 并用该渠道凭据」——与 §5.3 的 `auto` 同构。

厂商搜索服务形态（决定本期范围，见 §4.2）：

| 厂商 | 形态 | 请求 | 结果 |
| --- | --- | --- | --- |
| 智谱 GLM | 独立 REST | `POST /paas/v4/web_search`，`{search_query, search_engine, count}`，Bearer | `search_result[]`：`title/content/link/media/publish_date` |
| 阿里 Qwen | 聊天参数 | chat 的 `enable_search` / Responses 的 `web_search` 工具 | 模型答案 + 引用 |
| 小米 MiMo | 聊天插件 | chat 的 `tools:[{type:"web_search", max_keyword, force_search}]` | `message.annotations[]` 的 `url_citation` |

参考：[Claude 服务端工具](https://platform.claude.com/docs/en/agents-and-tools/tool-use/overview)、[Codex web search](https://learn.chatgpt.com/docs/web-search?surface=cli)、[Gemini CLI](https://geminicli.com/docs/tools/web-search/)、[OpenCode](https://opencode.ai/v2/docs/websearch/)、[OpenHands](https://docs.openhands.dev/openhands/usage/advanced/search-engine-setup)、[GLM Web Search](https://docs.bigmodel.cn/api-reference/%E5%B7%A5%E5%85%B7-api/%E7%BD%91%E7%BB%9C%E6%90%9C%E7%B4%A2.md)、[MiMo Web Search](https://mimo.mi.com/static/docs/quick-start/usage-guide/text-generation/tool-calling/web-search.md)、[Qwen 联网搜索](https://help.aliyun.com/zh/model-studio/web-search)。

### 4.2 本期范围与结构

**D-9：不做抓取兜底**；**D-10：搜索源 = 内置三预设 + 用户自定义端点源**。

- 内置预设：`deepseek`、`brave`、`glm`，只需填 key（DeepSeek 还可复用模型渠道的 key）。
- 自定义（endpoint 型）：方法 / URL / 鉴权头 / body 模板 / 结果映射，覆盖任何 REST 搜索接口（GLM 本身也能被用户自定义出来，但内置预设省事）。
- 聊天插件型（MiMo/Qwen）明确下一期。

代码结构选「适配器放在 `@voltojs/tools/web`，配置在网关，解析结果经 SDK 透传」：
备选（网关自造工具）会让 SDK 用户拿不到、两套实现漂移；纯模板方案（只有自定义端点、无内置预设）会让最常见的三家都要用户手写配置。

## 5. 设计

### 5.1 工具层：搜索源适配器（`packages/tools/src/web/search/`）

```ts
export type BuiltinSearchSourceId = "deepseek" | "brave" | "glm";

export interface SearchHit {
  title: string;
  url: string;
  snippet?: string;     // 短摘要（列表与轨迹用）
  summary?: string;     // 长摘要（给模型读）
  siteName?: string;
  publishedAt?: string; // 原样字符串，不强转
}

export interface SearchRequestOptions {
  apiKey?: string;
  baseUrl?: string;
  count: number;
}

/** 自定义端点源的规格（用户在设置页填的那些字段）。 */
export interface EndpointSourceSpec {
  method: "GET" | "POST";
  url: string;                       // GET 时可在 query 里写 {{query}} / {{count}}
  headers?: Record<string, string>;  // 额外静态头
  auth?: { header: string; prefix: string }; // 默认 { header: "Authorization", prefix: "Bearer " }
  bodyTemplate?: string;             // POST 专用；{{query}} 替换为 JSON 转义后的字符串（不含引号），{{count}} 为数字
  paths: {
    list: string;                    // 结果数组所在路径，如 "search_result"
    title: string;
    url: string;
    snippet?: string;
    summary?: string;
    siteName?: string;
    date?: string;
  };
}

export interface SearchAdapter {
  id: string;              // "deepseek" | "brave" | "glm" | 自定义源 id
  label: string;           // 展示名（"DeepSeek"、"Brave"、"GLM"、"我的搜索"）
  buildRequest(query: string, opts: SearchRequestOptions): NetworkRequest;
  /** 非 2xx 或结构不符时抛 SearchAdapterError(kind: "auth" | "http" | "shape")。 */
  parseResponse(resp: NetworkResponse, opts: SearchRequestOptions): SearchHit[];
}
```

内置适配器：

- `deepseek.ts`：`POST {base}/v1/tools/search`（base 去尾 `/v1` 再拼），`Authorization: Bearer`，body `{ query, count, need_content: false }`，解析 `results[]` 的 `title/url/snippet/summary/site_name/date`。query 截到 128 字符并在 `modelContent` 声明。
- `glm.ts`：`POST {base}/paas/v4/web_search`（base 默认 `https://open.bigmodel.cn/api`，只去尾斜杠），Bearer，body `{ search_query: query, search_engine: "search_std", count }`，解析 `search_result[]` 的 `title/link/content/media/publish_date`。query 截到 70 字符并声明。
- `brave.ts`：`GET {origin}/res/v1/web/search?q=&count=`，`X-Subscription-Token` + `Accept: application/json`，解析 `web.results[]` 的 `title/url/description`。旧 `apiUrl`（完整端点）继续用于该适配器。
- `endpoint.ts`：`createEndpointAdapter(id, label, spec, apiKey)`，纯函数实现模板渲染与路径取值：
  - GET：URL 里 `{{query}}` → `encodeURIComponent(query)`，`{{count}}` → 数字。
  - POST：`bodyTemplate` 里 `{{query}}` → JSON 转义串（用户自己写引号），`{{count}}` → 数字；渲染后必须能 `JSON.parse`，否则抛 `shape`。
  - 路径取值：`a.b.0.c` 形式，数字段索引数组；缺失字段 → 该字段 `undefined`，`list`、`title`、`url` 缺失则抛 `shape`。
- `index.ts`：`BUILTIN_ADAPTERS`、`createSearchAdapter(spec)`、`resolveBySource(source)`。

`web-search.ts`：`createWebSearchTool(network, opts?: WebSearchOptions)`

```ts
type WebSearchOptions =
  | { source: "off" }
  | {
      source: "none";
    }
  | {
      source: BuiltinSearchSourceId | "endpoint";
      sourceId: string;    // 自定义源用其 id，内置用同名字符串
      label: string;
      apiKey?: string;
      baseUrl?: string;
      endpoint?: EndpointSourceSpec;
      /** 兼容旧参：完整 URL，等价于 brave 的自定义端点。 */
      apiUrl?: string;
    };
```

输出：

- `modelContent`：编号列表 `1. title — url\n   date · site\n   summary/snippet`，总长截到 4000 字符并声明截断；0 条时「没有匹配结果」。
- `displayMetadata.webSearch`：`{ sourceId, sourceLabel, query, count, durationMs, status?, hits: 前 10 条（snippet/summary 各截 240 字符） }`。
- 失败 `isError: true`：鉴权（401/403，指向设置页该源）／网络（含 status）／未配置（`source: "none"`：「未配置搜索源；打开 设置 → 工具配置 → 网页搜索，可选 DeepSeek（可复用模型渠道）、Brave、GLM 或自定义搜索服务」）／模板错误（自定义源 body 渲染或解析失败，指出是哪个字段）。
- 权限与 schema 不变（`query`、`numResults`；`READ_ONLY`、`untrusted`、`requires: [CAP_NETWORK_FETCH]`）。`description` 说明搜索源由用户配置决定，支持 `site:` / `lang:` / `after:` 等语法。

### 5.2 配置：`config.json` 的 `webSearch` 段

**D-2 按源分槽存 key，同一个 key 绝不跨主机复用。**

```json
{
  "webSearch": {
    "source": "auto",
    "deepseek": { "apiKeyEnc": null, "sourceProviderId": null, "baseUrl": null },
    "brave": { "apiKeyEnc": null, "baseUrl": null },
    "glm": { "apiKeyEnc": null, "baseUrl": null },
    "custom": [
      {
        "id": "my-search",
        "name": "我的搜索",
        "apiKeyEnc": "v1:...",
        "endpoint": { "method": "POST", "url": "https://.../search", "auth": {...}, "headers": {}, "bodyTemplate": "...", "paths": {...} }
      }
    ]
  }
}
```

- `source`：`"auto" | "deepseek" | "brave" | "glm" | "<custom id>" | "off"`；缺段/缺失视为 `auto`。
- `deepseek.sourceProviderId`：复用哪条模型渠道（catalog provider id），与 `deepseek.apiKeyEnc` 互斥、优先。
- 校验分级（**D-6**）：写入端严格（PUT 拒绝未知键、非法 `source`、非法 URL、非法方法、渲染后不是合法 JSON 的 body 模板、缺 `paths.list/title/url`、非 DeepSeek 渠道 id）；读取端宽松（`loadWebSearchConfig` 返回 `{ config, warnings[] }`，拼错只让搜索退化，不让会话建不起来；对比 egress 是安全边界才 fail-closed）。
- 删掉自定义源时若 `source` 指向它 → 回落 `auto` + warning。
- 新增 `apps/gateway/src/config/web-search.ts`：`loadWebSearchConfig`、`readWebSearchSettingsView`、`updateWebSearchConfig`、`createCustomSource` / `updateCustomSource` / `deleteCustomSource`、`testWebSearch`、`resolveWebSearch`（§5.3）。
- `store.ts` 的 `ConfigSection` 增加 `"webSearch"`。
- `createProviderStore().readApiKey(providerId)` 新方法（内部 `cipher.decrypt`），**仅供服务端**。
- **D-7 候选渠道**：`piProvider === "deepseek"` 或 baseURL 主机以 `deepseek.com` 结尾的渠道；其它渠道既不进候选，PUT 也拒绝——不把无关服务的 key 发往搜索主机。

### 5.3 解析：源如何选中

在 wiring 每次会话构建时执行，产出 `WebSearchOptions`（key 只在内存里，不进事件/日志/displayMetadata）。

1. `source === "off"` → `{ source: "off" }`，不装配 `web_search`（模型看不到；D-1）。
2. `source === "deepseek"` → `sourceProviderId` 有值用其 key + 渠道 baseURL 派生；否则用 `deepseek.apiKeyEnc` + `deepseek.baseUrl`；都缺 → `none`（工具可见、返回指引）。
3. `source === "brave"` / `"glm"` → 对应槽位的 key（缺失时仍装配，调用报鉴权指引）。
4. `source` 是自定义 id → 找到该源，用其 key + endpoint spec；找不到 → `none` + warning。
5. `source === "auto"`（默认）：
   - a. 会话模型渠道是 DeepSeek 且有 key → deepseek（复用该 key，端点由该渠道 baseURL 派生）。**零配置的唯一路径。**
   - b. 否则 → `none`（工具可见、返回指引）。
6. 「跟随模型」的粒度是会话默认模型渠道（`opts.providerId`）；路由档位的单次派发不改变搜索源——本期已知简化，写进文档。

### 5.4 SDK 透传

- `createAgent` 新选项 `webSearch?: WebSearchOptions`（见 §5.1）。
- **D-1 语义**：`off` → 三处装配点都不注册 `web_search`；`none`/不传 → 仍注册，调用返回配置指引（保持「有 network 就有 web_search」，因为通用网关里用户不知道有这个能力，摘掉等于永远发现不了）。
- 三处装配点统一：`adapterTools.push(createWebSearchTool(network, opts.webSearch))`、`createNetworkToolExecutor({ network, webSearch })`（`packages/runtimes/node` 同步签名）、子代理经 `{ ...opts, network }` 继承。
- 不用 `toolVisibility`：它按 group 关，会连带关掉 `web_fetch`/`http_query`。
- 有意变更：不传 `webSearch` 且不传 `apiUrl` 时，从「GET Brave 无 key 必失败」变成「明确告诉你没配搜索源」。

### 5.5 网关 HTTP 与设置页

- `GET /config/web-search` → `{ source, resolved: { sourceId, label, reason }, builtins: { deepseek: { apiKeyMasked, sourceProviderId, baseUrl }, brave: { apiKeyMasked, baseUrl }, glm: { apiKeyMasked, baseUrl } }, custom: [{ id, name, method, url, apiKeyMasked }], candidates: [{ id, name, apiKeyMasked }], warnings: string[] }`。
- `PUT /config/web-search` → 更新 `source` 与三个内置槽（`apiKey` 传 null/空串 = 清除）；严格校验。
- `POST /config/web-search/custom` / `PUT /config/web-search/custom/:id` / `DELETE /config/web-search/custom/:id` → 自定义源的增删改（`endpoint` spec 原样进出；key 只进不出）。
- `POST /config/web-search/test` → `{ source?: string; query?: string; providerId?: string }`（缺省用当前 `source` 与 `"DeepSeek"`）。**D-4**：解析路径与「新建会话」完全一致（`providerId` 缺省 `preferences.lastProviderId`），网络用 `createNodeNetwork()` + `wrapNetworkWithEgress(egressPolicy)`，避免「测试通过、agent 失败」。响应 `{ resolved, durationMs, hits }` 或 `{ error, resolved }`。密钥不出服务端。
- `apps/web/lib/config-api.ts` 增加 `fetchWebSearchSettings / updateWebSearchSettings / createCustomSource / updateCustomSource / deleteCustomSource / testWebSearch`。
- `ToolsPanel` 新增卡片「网页搜索」（浏览器卡片上方）：
  - 顶部一行「当前解析：自动 → 复用 DeepSeek 渠道 deepseek-official」或「自动 → 未配置」。
  - 搜索源 select：自动（跟随模型）/ DeepSeek / Brave / GLM / 自定义源列表 / 关闭。
  - 选中内置源时显示该源的 key 槽；DeepSeek 额外有「填写 API Key / 复用模型渠道」二选一（渠道下拉，候选为空时提示先去模型配置添加）。
  - 「+ 添加自定义搜索服务」打开表单：名称、方法、URL、鉴权头与前缀、额外 headers、body 模板、结果映射（列表/title/url/snippet/summary/siteName/date）、key。表单里带「测试」按钮。
  - 自定义源列表项可编辑、删除；删除当前选中源时提示将回落到「自动」。
  - 「测试搜索」按钮 + 结果（前 3 条标题+链接，或错误；显示实际解析到的源）。
  - warnings 以提示行展示（如「渠道已不存在，已退回未配置状态」）。
  - 保存提示：新建会话生效；已有会话在下次重建时生效（不写「重启网关」）。
  - 文案进 `apps/web/messages/{zh,en}/settings.json` 的 `tools.*`。

### 5.6 轨迹展示

- `packages/core/src/view-projection.ts` 增加窄类型 `WebSearchReport`（`sourceId`、`sourceLabel`、`query`、`count`、`durationMs?`、`status?`、`hits[]`），与 `fileChange` 同款：从 `tool_result` 的 `displayMetadata.webSearch` 提取，投影到 `ConversationToolCall.search`（重放/刷新后一致，无需额外请求）。
- `tool-summary.ts`：`web_search` 摘要带源与条数，如 `"GLM · query（5 条）"`。
- `ToolCallCard`：有 `search` 的调用渲染结构化详情——源与耗时徽标、query、逐条「标题（链接）— 摘要 — 日期」，超过 5 条折叠；原始参数区保留。
- `TrajectoryRow` 沿用 `summary` + `durationMs`。

### 5.7 文档

- `docs/user/reference/config-sections.json` 新增 `webSearch` 段（中英）：source 取值、三个内置槽、自定义源、生效时机、密钥存储。
- `docs/user/reference/tool-notes.json` 更新 `web_search` 描述。
- `docs/user/using/guides/web-search.md`（中英）+ README 索引：怎么配三家、自定义源怎么写（含 GLM 模板示例）、auto 的退化顺序、egress 需放行 `api.deepseek.com` / `api.search.brave.com` / `open.bigmodel.cn` 与自定义主机。
- `pnpm docs:gen` 产出、`docs:check` 把关。

## 6. 测试

- `packages/tools`：deepseek / glm / brave 的 request 与 parse（DeepSeek、GLM 用官方文档示例响应，Brave 用录制 JSON）；endpoint 适配器（GET 编码、POST 模板 JSON 转义、渲染后非法 JSON、点号路径取值、缺失必填字段）；非 2xx、结构不符、0 条、超长截断、旧 `apiUrl/apiKey` 兼容、`none` 不发请求且返回指引。
- `packages/sdk`：`webSearch` 透传到工具与 network executor；子代理继承；`off` 时不在可见集合；`none`/不传时可见。
- `apps/gateway`：配置读写/掩码/严格校验；自定义源增删改与 id 冲突；删除选中源回落；`auto` 解析矩阵（渠道是/不是 DeepSeek、渠道无 key、providerId 失效、source off）；拒绝非 DeepSeek 渠道；五条路由；test 路由走 egress 包装。
- `packages/core`：`displayMetadata.webSearch` → `ConversationToolCall.search` 投影。
- `apps/web`：ToolsPanel 渲染/保存、按源切换 key 槽、自定义源表单与增删、解析结果行、测试成功/失败、工具摘要、ToolCallCard 详情。
- 门禁：`pnpm turbo run typecheck lint test --filter @voltojs/tools --filter @voltojs/sdk --filter @voltojs/core --filter @voltojs/gateway --filter @voltojs/web`（排除 desktop-app），再 `pnpm turbo run build` + `pnpm docs:check`。

## 7. 风险与已知限制

- **非 DeepSeek 渠道没有零配置搜索**：OpenAI/Anthropic 等走 `auto` 会落到「未配置」，必须配 Brave/GLM/自定义。与 OpenHands/Cline 一致，文档写清。
- **自定义端点会把 key 发到用户指定的主机**：这是用户显式选择；网关只做格式校验，egress 名单若不配就不限制目标。文档与表单提示写明。
- **模板表达力**：body 模板只做 `{{query}}`/`{{count}}` 替换，不支持条件/循环；遇到需要动态引擎参数的接口（如 GLM 多引擎），用户在模板里写死。够用即可，不引入表达式引擎。
- **Brave/GLM 映射靠文档**：用官方示例/录制 fixture 锁定；若线上结构不同，只改对应适配器文件。
- **生效时机**：每个会话构建时读配置；已建会话要等下次重建（切模型/重启网关），设置页文案如实写。
- **egress**：配了允许名单却漏放行搜索主机时工具失败——报错点名主机；test 路由同样走 egress。
- **路由档位**：单次派发切到别的模型不改变搜索源。

## 8. 交付顺序（供写计划参考）

1. tools/web：三个内置适配器 + endpoint 适配器 + 工具改造（含单测）。
2. core 投影字段 + sdk 透传（`off`/`none`）。
3. gateway：配置读写 + 自定义源 CRUD + auto 解析 + 路由。
4. web：设置页（内置槽 + 自定义源表单）+ 轨迹展示。
5. 文档与 `docs:gen`/`docs:check`；门禁与手工验收（真 key 跑 DeepSeek、GLM 各一次；自定义源用 GLM 模板跑一次；非 DeepSeek 渠道看未配置指引；轨迹逐条结果）。
