# 网页搜索配置 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use subagent-driven-development (recommended) or executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在「设置 → 工具配置」里增加网页搜索配置（内置 DeepSeek/Brave/GLM 加用户自定义端点源），并让 `web_search` 真正用上它、在对话轨迹里结构化展示搜索过程。

**Architecture:** 协议与解析收在 `@voltojs/tools/web`（纯适配器：buildRequest/parseResponse）；网关负责配置、密钥、解析出「源规格」；SDK 把规格透传给工具；core 只做 `displayMetadata.webSearch` → `ConversationToolCall.search` 的投影；web 只做表单与展示。

**Tech Stack:** TypeScript strict、pnpm + Turborepo、Vitest、Zod（仅 tools/sdk）、Next.js（apps/web）、Node http（apps/gateway）。

**Spec:** `docs/superpowers/specs/2026-11-18-web-search-config-design.md`

## Global Constraints

- 工作目录：`/Users/leo.zheng/Documents/github_workspace/volto.worktrees/feat-web-search-config`（分支 `feat/web-search-config`）。
- core 纯净：`packages/core` 不引入 `node:*`、不做 I/O、不 import 任何实现包；只加类型与纯投影。
- 依赖方向：core ← tools ← sdk ← apps；`zod` 只允许出现在 `packages/tools` 与 `packages/sdk`。
- tools/sdk/gateway 里的 core 引用一律 `import type`。
- 代码注释与 commit message 用英文；commit 用 Conventional Commits，禁止任何 AI 署名尾注。
- 每个包的门禁：`pnpm turbo run typecheck lint test --filter <包名>`；跨包测试前先 `pnpm turbo run build --filter <上游包>`（tools/sdk 消费 dist）。
- 永远排除 `@voltojs/desktop-app`。
- 用户可见文案必须走 `apps/web/messages/{zh,en}/settings.json`（`node scripts/check-i18n-hardcoded.mjs` 会拦中文硬编码）。
- 改到用户可见面 → 同一次提交里同步 `docs/user/`；生成页只跑 `pnpm docs:gen`，最后 `pnpm docs:check`。
- `web_search` 的工具名、`riskTier: READ_ONLY`、`trust: untrusted`、`requires: [CAP_NETWORK_FETCH]` 保持不变。

## Review Focus

1. **query 含引号/反斜杠/中文/换行** 时，自定义 body 模板替换必须产生合法 JSON 且不破坏结构（期望：渲染后 `JSON.parse` 成功，query 原样出现在字符串值里）。
2. **body 模板渲染后非法 JSON、或 `paths.list/title/url` 指不到字段**：必须以 `SearchAdapterError(kind: "shape")` 失败并指明字段，而不是把损坏的结果交给模型。
3. **egress 允许名单只放行部分主机**：403 要落在「网络/出口」错误里并点名主机，不能被当成鉴权失败或静默空结果。
4. **会话模型渠道切到非 DeepSeek**：`auto` 必须落到 `none`（工具可见、报「未配置搜索源」），不能报 401 误导用户。
5. **删除当前选中的自定义源**：`source` 必须回落 `auto` 且带 warning，不能留下指向不存在 id 的悬空选中。
6. **50 条结果 + 长 summary**：`displayMetadata.webSearch.hits` 只留前 10 条、摘要各截 240 字符，事件体积不随厂商返回膨胀。

---

### Task 1: tools — 搜索源类型与 DeepSeek 适配器

**Files:**
- Create: `packages/tools/src/web/search/types.ts`
- Create: `packages/tools/src/web/search/deepseek.ts`
- Test: `packages/tools/src/web/search/__tests__/deepseek.test.ts`

**Interfaces:**
- Produces: `SearchHit`、`SearchRequestOptions`、`SearchAdapterError`（`kind: "auth" | "http" | "shape"`、`status?: number`）、`SearchAdapter { id; label; buildRequest(query, opts): NetworkRequest; parseResponse(resp, opts): SearchHit[] }`、`BuiltinSearchSourceId = "deepseek" | "brave" | "glm"`、`createDeepSeekAdapter(): SearchAdapter`。

- [ ] **Step 1: 写失败测试**

```ts
// packages/tools/src/web/search/__tests__/deepseek.test.ts
const ok = (body: string, status = 200): NetworkResponse => ({ status, headers: {}, body });

it("builds a POST with bearer auth and need_content false", () => {
  const req = createDeepSeekAdapter().buildRequest("deepseek v4", { apiKey: "k", count: 5 });
  expect(req.method).toBe("POST");
  expect(req.url).toBe("https://api.deepseek.com/v1/tools/search");
  expect(req.headers?.["Authorization"]).toBe("Bearer k");
  expect(JSON.parse(req.body!)).toEqual({ query: "deepseek v4", count: 5, need_content: false });
});

it("strips a trailing /v1 from baseUrl", () => {
  const req = createDeepSeekAdapter().buildRequest("q", { baseUrl: "https://proxy.example.com/v1/", count: 3 });
  expect(req.url).toBe("https://proxy.example.com/v1/tools/search");
});

it("clamps query to 128 characters", () => {
  const req = createDeepSeekAdapter().buildRequest("x".repeat(200), { count: 3 });
  expect(JSON.parse(req.body!).query).toHaveLength(128);
});

it("parses results and maps site_name/date", () => {
  const hits = createDeepSeekAdapter().parseResponse(ok(JSON.stringify({
    results: [{ title: "T", url: "https://e.com", snippet: "s", summary: "S", site_name: "E", date: "2026-06-01T00:00:00+00:00" }],
  })), { count: 5 });
  expect(hits).toEqual([{ title: "T", url: "https://e.com", snippet: "s", summary: "S", siteName: "E", publishedAt: "2026-06-01T00:00:00+00:00" }]);
});

it("throws auth on 401 and shape on a non-array results", () => {
  expect(() => createDeepSeekAdapter().parseResponse(ok("{}", 401), { count: 5 }))
    .toThrowError(expect.objectContaining({ kind: "auth", status: 401 }));
  expect(() => createDeepSeekAdapter().parseResponse(ok("{}"), { count: 5 }))
    .toThrowError(expect.objectContaining({ kind: "shape" }));
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm vitest run packages/tools/src/web/search/__tests__/deepseek.test.ts`
Expected: FAIL — 模块不存在。

- [ ] **Step 3: 实现类型与适配器**

`types.ts`：按上面 Interfaces 定义 `SearchAdapter`、`SearchHit`、`SearchRequestOptions`、`EndpointSourceSpec`（`method: "GET" | "POST"`、`url`、`headers?`、`auth?: { header; prefix }`、`bodyTemplate?`、`paths: { list; title; url; snippet?; summary?; siteName?; date? }`）、`SearchAdapterError`。
`deepseek.ts`：规整 `baseUrl`（trim、去尾斜杠、若以 `/v1` 结尾则去掉，缺省 `https://api.deepseek.com`），端点 `${base}/v1/tools/search`；`parseResponse` 先按 `resp.status` 分 `auth`/`http`，再 `JSON.parse` 取 `results` 数组，缺失即 `shape`。

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm vitest run packages/tools/src/web/search/__tests__/deepseek.test.ts`
Expected: PASS（5 个用例）。

- [ ] **Step 5: 提交**

```bash
git add packages/tools/src/web/search
git commit -m "feat(tools): add DeepSeek search adapter"
```

### Task 2: tools — GLM 与 Brave 适配器

**Files:**
- Create: `packages/tools/src/web/search/glm.ts`、`packages/tools/src/web/search/brave.ts`
- Test: `packages/tools/src/web/search/__tests__/glm.test.ts`、`.../brave.test.ts`

**Interfaces:**
- Consumes: Task 1 的 `SearchAdapter` / `SearchAdapterError`。
- Produces: `createGlmAdapter()`、`createBraveAdapter()`。

- [ ] **Step 1: 写失败测试**

```ts
// glm.test.ts
it("posts to /paas/v4/web_search with search_std and a 70-char query", () => {
  const req = createGlmAdapter().buildRequest("x".repeat(120), { apiKey: "k", count: 8 });
  expect(req.url).toBe("https://open.bigmodel.cn/api/paas/v4/web_search");
  expect(JSON.parse(req.body!)).toEqual({ search_query: "x".repeat(70), search_engine: "search_std", count: 8 });
});
it("maps search_result fields", () => {
  const hits = createGlmAdapter().parseResponse({ status: 200, headers: {}, body: JSON.stringify({
    search_result: [{ title: "T", content: "C", link: "https://g.com", media: "站点", publish_date: "2026-01-01" }],
  }) }, { count: 8 });
  expect(hits[0]).toEqual({ title: "T", url: "https://g.com", snippet: "C", summary: "C", siteName: "站点", publishedAt: "2026-01-01" });
});

// brave.test.ts
it("builds the legacy GET shape", () => {
  const req = createBraveAdapter().buildRequest("a b", { apiKey: "k", count: 4 });
  expect(req.method).toBe("GET");
  expect(req.url).toBe("https://api.search.brave.com/res/v1/web/search?q=a%20b&count=4");
  expect(req.headers?.["X-Subscription-Token"]).toBe("k");
});
it("parses web.results", () => {
  const hits = createBraveAdapter().parseResponse({ status: 200, headers: {}, body: JSON.stringify({
    web: { results: [{ title: "T", url: "https://b.com", description: "D" }] },
  }) }, { count: 4 });
  expect(hits).toEqual([{ title: "T", url: "https://b.com", snippet: "D" }]);
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm vitest run packages/tools/src/web/search/__tests__/glm.test.ts packages/tools/src/web/search/__tests__/brave.test.ts`
Expected: FAIL — 模块不存在。

- [ ] **Step 3: 实现两个适配器**

GLM：base 缺省 `https://open.bigmodel.cn/api`，只去尾斜杠；Bearer；body `{ search_query, search_engine: "search_std", count }`；解析 `search_result[]`，`content` 同时给 `snippet` 与 `summary`。
Brave：base 缺省 `https://api.search.brave.com`（origin）；`/res/v1/web/search`；`q` URL 编码；解析 `web.results[]`，`description` → `snippet`。

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm vitest run packages/tools/src/web/search/__tests__/glm.test.ts packages/tools/src/web/search/__tests__/brave.test.ts`
Expected: PASS。

- [ ] **Step 5: 提交**

```bash
git add packages/tools/src/web/search
git commit -m "feat(tools): add GLM and Brave search adapters"
```

### Task 3: tools — 自定义端点适配器

**Files:**
- Create: `packages/tools/src/web/search/endpoint.ts`
- Test: `packages/tools/src/web/search/__tests__/endpoint.test.ts`

**Interfaces:**
- Consumes: `EndpointSourceSpec`、`SearchAdapter`、`SearchAdapterError`。
- Produces: `createEndpointAdapter(params: { id: string; label: string; spec: EndpointSourceSpec }): SearchAdapter`。

- [ ] **Step 1: 写失败测试**

```ts
const spec: EndpointSourceSpec = {
  method: "POST",
  url: "https://search.example.com/v1/search",
  auth: { header: "Authorization", prefix: "Bearer " },
  bodyTemplate: '{"q": "{{query}}", "n": {{count}}}',
  paths: { list: "data.items", title: "name", url: "link", snippet: "digest", summary: "digest", date: "published" },
};

it("escapes the query into valid JSON", () => {
  const req = createEndpointAdapter({ id: "x", label: "X", spec }).buildRequest('he said "hi"\n', { apiKey: "k", count: 7 });
  const body = JSON.parse(req.body!);
  expect(body).toEqual({ q: 'he said "hi"\n', n: 7 });
  expect(req.headers?.["Authorization"]).toBe("Bearer k");
});

it("supports GET with encoded placeholders", () => {
  const getSpec = { ...spec, method: "GET" as const, url: "https://s.example.com/s?q={{query}}&n={{count}}", bodyTemplate: undefined };
  const req = createEndpointAdapter({ id: "x", label: "X", spec: getSpec }).buildRequest("a b", { count: 3 });
  expect(req.url).toBe("https://s.example.com/s?q=a%20b&n=3");
});

it("reads dotted paths and indexes arrays", () => {
  const resp = { status: 200, headers: {}, body: JSON.stringify({ data: { items: [{ name: "T", link: "https://i.com", digest: "D", published: "2026-02-02" }] } }) };
  expect(createEndpointAdapter({ id: "x", label: "X", spec }).parseResponse(resp, { count: 3 }))
    .toEqual([{ title: "T", url: "https://i.com", snippet: "D", summary: "D", publishedAt: "2026-02-02" }]);
});

it("fails shape on a broken template or a missing required path", () => {
  const broken = { ...spec, bodyTemplate: '{"q": "{{query}"}' };
  expect(() => createEndpointAdapter({ id: "x", label: "X", spec: broken }).buildRequest("q", { count: 3 }))
    .toThrowError(expect.objectContaining({ kind: "shape" }));
  const noList = { ...spec, paths: { ...spec.paths, list: "nope" } };
  expect(() => createEndpointAdapter({ id: "x", label: "X", spec: noList }).parseResponse({ status: 200, headers: {}, body: "{}" }, { count: 3 }))
    .toThrowError(expect.objectContaining({ kind: "shape" }));
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm vitest run packages/tools/src/web/search/__tests__/endpoint.test.ts`
Expected: FAIL。

- [ ] **Step 3: 实现适配器**

替换规则：`{{query}}` → JSON 转义后的裸字符串（用户自己写引号）；`{{count}}` → 数字。GET 时两者都 URL 编码，`{{count}}` 不编码数字。渲染后 `JSON.parse` 失败 → `SearchAdapterError("shape", "bodyTemplate 渲染后不是合法 JSON")`。路径解析：按 `.` 分段，纯数字段索引数组；`list` 必须解析出数组，`title`/`url` 缺失 → `shape`。

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm vitest run packages/tools/src/web/search/__tests__/endpoint.test.ts`
Expected: PASS。

- [ ] **Step 5: 提交**

```bash
git add packages/tools/src/web/search
git commit -m "feat(tools): add custom endpoint search adapter"
```

### Task 4: tools — 重写 `web_search` 工具

**Files:**
- Create: `packages/tools/src/web/search/index.ts`
- Modify: `packages/tools/src/web/web-search.ts`（整体替换实现）
- Modify: `packages/tools/src/web/index.ts`（导出新类型与工厂）
- Test: `packages/tools/src/web/__tests__/web-search.test.ts`（新文件；保留 `web-fetch.test.ts` 与 `tc-e11-*.test.ts` 里仍然成立的用例，旧的 `web_search` 断言迁到这里）

**Interfaces:**
- Produces: `createSearchAdapter(input: { source: BuiltinSearchSourceId | "endpoint"; id: string; label: string; endpoint?: EndpointSourceSpec }): SearchAdapter`、`WebSearchToolOptions`、`createWebSearchTool(network, opts?: WebSearchToolOptions)`。

```ts
export type WebSearchToolOptions =
  | { source: "off" }
  | { source: "none" }
  | { source: BuiltinSearchSourceId | "endpoint"; sourceId: string; label: string;
      apiKey?: string; baseUrl?: string; endpoint?: EndpointSourceSpec; apiUrl?: string };
```

- [ ] **Step 1: 写失败测试**

```ts
it("returns guidance without touching the network when source is none", async () => {
  const fetch = vi.fn();
  const tool = createWebSearchTool({ fetch }, { source: "none" });
  const result = await tool.handler({ query: "x" });
  expect(fetch).not.toHaveBeenCalled();
  expect(result.isError).toBe(true);
  expect(result.modelContent).toContain("设置 → 工具配置");
});

it("renders hits for the model and metadata for the UI", async () => {
  const tool = createWebSearchTool(fakeNetwork({ results: [{ title: "T", url: "https://e.com", summary: "S" }] }),
    { source: "deepseek", sourceId: "deepseek", label: "DeepSeek", apiKey: "k" });
  const result = await tool.handler({ query: "q", numResults: 3 });
  expect(result.modelContent).toContain("1. T — https://e.com");
  expect(result.modelContent).toContain("S");
  const meta = result.displayMetadata!.webSearch as { sourceLabel: string; count: number; hits: unknown[] };
  expect(meta.sourceLabel).toBe("DeepSeek");
  expect(meta.count).toBe(1);
  expect(meta.hits).toHaveLength(1);
});

it("caps metadata hits at 10 and summaries at 240 chars", async () => {
  const many = Array.from({ length: 30 }, (_, i) => ({ title: `T${i}`, url: `https://e.com/${i}`, summary: "s".repeat(500) }));
  const result = await createWebSearchTool(fakeNetwork({ results: many }), { source: "deepseek", sourceId: "deepseek", label: "DeepSeek", apiKey: "k" }).handler({ query: "q" });
  const meta = result.displayMetadata!.webSearch as { hits: Array<{ summary?: string }> };
  expect(meta.hits).toHaveLength(10);
  expect(meta.hits[0]!.summary).toHaveLength(240);
});

it("keeps the legacy apiUrl option working as a Brave endpoint", async () => {
  const tool = createWebSearchTool(fakeNetwork({ web: { results: [{ title: "T", url: "https://b.com" }] } }), { source: "brave", sourceId: "brave", label: "Brave", apiKey: "k", apiUrl: "https://proxy.example.com/search" });
  await tool.handler({ query: "q" });
  expect(fetchMock.mock.calls[0]![0].url).toBe("https://proxy.example.com/search?q=q&count=5");
});

it("surfaces an egress denial as a network error naming the host", async () => {
  const denied = { status: 403, headers: {}, body: '{"error":"network egress denied: api.search.brave.com"}' };
  const result = await createWebSearchTool(fakeNetwork(denied), { source: "brave", sourceId: "brave", label: "Brave", apiKey: "k" }).handler({ query: "q" });
  expect(result.isError).toBe(true);
  expect(result.modelContent).toContain("api.search.brave.com");
});

it("reports auth errors with a pointer to settings", async () => {
  const result = await createWebSearchTool(fakeNetwork("{}", 401), { source: "glm", sourceId: "glm", label: "GLM", apiKey: "k" }).handler({ query: "q" });
  expect(result.isError).toBe(true);
  expect(result.modelContent).toContain("GLM");
  expect(result.modelContent).toContain("设置");
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm vitest run packages/tools/src/web/__tests__/web-search.test.ts`
Expected: FAIL。

- [ ] **Step 3: 实现**

`search/index.ts` 装配：`deepseek`/`brave`/`glm` 用内置工厂，`endpoint` 用 `createEndpointAdapter`。工具 `run`：`none` 直接返回指引；否则 `buildRequest` → `network.fetch`（带 `abortSignal`）→ `parseResponse` → 组装 `modelContent`（编号列表，4000 字符截断，0 条输出「没有匹配结果」）与 `displayMetadata.webSearch`；捕获 `SearchAdapterError` 与未知错误，按 `auth`/`http`/`shape` 出三类文案（`auth` 与未配置的文案都要包含「设置」与对应源名）。403 与非 2xx 的响应体要原样（截短后）带进 `modelContent`——egress 拒绝的正文里有主机名，那是用户修配置唯一需要的线索。
`web/index.ts` 追加导出 `WebSearchToolOptions`、`SearchHit`、`EndpointSourceSpec`、`SearchAdapterError`。

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm vitest run packages/tools/src/web`
Expected: PASS（含既有的 web-fetch 用例）。

- [ ] **Step 5: 提交**

```bash
git add packages/tools/src/web
git commit -m "feat(tools): drive web_search from a configured search source"
```

### Task 5: core — `web_search` 报告投影

**Files:**
- Modify: `packages/core/src/view-projection.ts`（`WebSearchReport` 类型、`ConversationToolCall.search`、提取函数、投影处接线）
- Test: `packages/core/src/__tests__/web-search-projection.test.ts`

**Interfaces:**
- Produces: `WebSearchReport { sourceId: string; sourceLabel: string; query: string; count: number; durationMs?: number; status?: number; hits: Array<{ title; url; snippet?; summary?; siteName?; publishedAt? }> }`，以及 `ConversationToolCall.search?: WebSearchReport`。

- [ ] **Step 1: 写失败测试**

```ts
it("projects displayMetadata.webSearch onto the conversation tool call", () => {
  const call = projectSingleCall({
    name: "web_search",
    result: "1. T — https://e.com",
    displayMetadata: { webSearch: { sourceId: "glm", sourceLabel: "GLM", query: "q", count: 1, durationMs: 120, hits: [{ title: "T", url: "https://e.com" }] } },
  });
  expect(call.search).toEqual({ sourceId: "glm", sourceLabel: "GLM", query: "q", count: 1, durationMs: 120, hits: [{ title: "T", url: "https://e.com" }] });
});

it("omits the field for other tools and for malformed metadata", () => {
  expect(projectSingleCall({ name: "bash", result: "x", displayMetadata: {} }).search).toBeUndefined();
  expect(projectSingleCall({ name: "web_search", result: "x", displayMetadata: { webSearch: { hits: "nope" } } }).search).toBeUndefined();
});
```

（`projectSingleCall` 是测试内的构造助手：用 `createInitialState` + 一次 `tool_result` 事件生成 `ConversationView`，取第一个 `tool_call`。）

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm vitest run packages/core/src/__tests__/web-search-projection.test.ts`
Expected: FAIL — `search` 不存在。

- [ ] **Step 3: 实现**

照 `fileChangeFields` 的模式加 `searchReportFields(displayMetadata)`：`displayMetadata.webSearch` 必须是对象、`hits` 必须是数组且每项 `title`/`url` 是字符串，否则返回 `{}`；在 `blocks.push({ type: "tool_call", call: { ... } })` 处 `...searchReportFields(call?.displayMetadata)`。导出 `WebSearchReport`。

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm vitest run packages/core/src/__tests__/web-search-projection.test.ts`
Expected: PASS。

- [ ] **Step 5: 提交**

```bash
git add packages/core
git commit -m "feat(core): project web search reports into conversation tool calls"
```

### Task 6: sdk + runtime — `webSearch` 透传

**Files:**
- Modify: `packages/sdk/src/create-agent.ts`（新选项与三处装配）
- Modify: `packages/runtimes/node/src/network-tool-executor.ts`
- Test: `packages/sdk/src/__tests__/web-search-option.test.ts`

**Interfaces:**
- Consumes: Task 4 的 `WebSearchToolOptions`、`createWebSearchTool`。
- Produces: `CreateAgentOptions.webSearch?: WebSearchToolOptions`；`CreateNetworkToolExecutorOptions.webSearch?: WebSearchToolOptions`。

- [ ] **Step 1: 写失败测试**

```ts
it("registers web_search with the configured label when a source is set", async () => {
  const agent = createAgent({ network: fakeNetwork, webSearch: { source: "glm", sourceId: "glm", label: "GLM", apiKey: "k" } });
  expect(agent.toolNames()).toContain("web_search");
});

it("does not register web_search when the source is off", async () => {
  const agent = createAgent({ network: fakeNetwork, webSearch: { source: "off" } });
  expect(agent.toolNames()).not.toContain("web_search");
});

it("still registers web_search with guidance when nothing is configured", async () => {
  const agent = createAgent({ network: fakeNetwork, webSearch: { source: "none" } });
  expect(agent.toolNames()).toContain("web_search");
});
```

（`toolNames()` 用现有的 tool 集合读取方式；若没有该访问器，用测试里已用的等价手段取 `ToolRouter` 可见集合。）

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm turbo run build --filter @voltojs/tools && pnpm vitest run packages/sdk/src/__tests__/web-search-option.test.ts`
Expected: FAIL。

- [ ] **Step 3: 实现**

`create-agent.ts`：在 `network` 选项旁加 `webSearch`，并把 `if (network) { adapterTools.push(createWebFetchTool(network), createWebSearchTool(network)); ... }` 改成：`opts.webSearch?.source !== "off"` 时才 `push(createWebSearchTool(network, opts.webSearch))`；`createNetworkToolExecutor({ network, ...(opts.webSearch ? { webSearch: opts.webSearch } : {}) })`；子代理的 `opts` 透传已覆盖，确认 `networkExecutor` 分支同样带 `webSearch`。
`network-tool-executor.ts`：选项加 `webSearch?: WebSearchToolOptions`，`source === "off"` 时 `tools` 数组不含 `web_search`，否则 `createWebSearchTool(options.network, options.webSearch)`。

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm turbo run build --filter @voltojs/runtime-node && pnpm vitest run packages/sdk/src/__tests__/web-search-option.test.ts`
Expected: PASS。

- [ ] **Step 5: 提交**

```bash
git add packages/sdk packages/runtimes/node
git commit -m "feat(sdk): thread the web search source through agent assembly"
```

### Task 7: gateway — 配置读写与内置槽

**Files:**
- Create: `apps/gateway/src/config/web-search.ts`
- Modify: `apps/gateway/src/config/store.ts`（`ConfigSection` 加 `"webSearch"`）
- Modify: `apps/gateway/src/config/providers.ts`（`readApiKey(providerId)`）
- Test: `apps/gateway/src/__tests__/web-search-config.test.ts`

**Interfaces:**
- Produces: `WebSearchConfig`、`loadWebSearchConfig(configDir): Promise<{ config: WebSearchConfig; warnings: string[] }>`、`readWebSearchSettingsView(configDir): Promise<WebSearchSettingsView>`、`updateWebSearchConfig(configDir, input): Promise<WebSearchSettingsView>`、`createProviderStore().readApiKey(id): Promise<string | null>`。

```ts
export interface WebSearchConfig {
  source: "auto" | "deepseek" | "brave" | "glm" | string;
  deepseek: { apiKeyEnc: string | null; sourceProviderId: string | null; baseUrl: string | null };
  brave: { apiKeyEnc: string | null; baseUrl: string | null };
  glm: { apiKeyEnc: string | null; baseUrl: string | null };
  custom: CustomSearchSource[];
}
```

- [ ] **Step 1: 写失败测试**

```ts
it("returns defaults for an absent section", async () => {
  const { config, warnings } = await loadWebSearchConfig(dir);
  expect(config.source).toBe("auto");
  expect(config.custom).toEqual([]);
  expect(warnings).toEqual([]);
});

it("warns instead of throwing on an invalid source", async () => {
  await writeConfig(dir, { webSearch: { source: "nope" } });
  const { config, warnings } = await loadWebSearchConfig(dir);
  expect(config.source).toBe("auto");
  expect(warnings.join()).toContain("source");
});

it("masks keys in the view and never returns plaintext", async () => {
  await updateWebSearchConfig(dir, { source: "glm", glm: { apiKey: "sk-1234567890" } });
  const view = await readWebSearchSettingsView(dir);
  expect(view.builtins.glm.apiKeyMasked).toBe("••••7890");
  expect(JSON.stringify(view)).not.toContain("sk-1234567890");
});

it("rejects an unknown key and a bad source on write", async () => {
  await expect(updateWebSearchConfig(dir, { source: "nope" })).rejects.toThrow();
  await expect(updateWebSearchConfig(dir, { source: "glm", glm: { apiKey: "k", bogus: 1 } })).rejects.toThrow();
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm vitest run apps/gateway/src/__tests__/web-search-config.test.ts`
Expected: FAIL。

- [ ] **Step 3: 实现**

`loadWebSearchConfig`：读 `config.json` 的 `webSearch`；缺段 → 默认值与空 warnings；结构不对 → 逐项降级并收集 warning（**不抛**）；`source` 不在合法集合 → `auto` + warning。`updateWebSearchConfig`：严格校验（未知键、非法 source、非 http(s) URL → 抛 `WebSearchConfigError`），`apiKey` 非空时 `cipher.encrypt`，`null`/`""` 清除；返回 view。view 里 key 一律 `maskKey()`（保留后 4 位，形如 `••••7890`）。`providers.ts` 的 `readApiKey` 用同一个 cipher 解密 `apiKeyEnc`，找不到返回 `null`。

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm vitest run apps/gateway/src/__tests__/web-search-config.test.ts`
Expected: PASS。

- [ ] **Step 5: 提交**

```bash
git add apps/gateway/src/config
git commit -m "feat(gateway): add web search config store"
```

### Task 8: gateway — 自定义源 CRUD

**Files:**
- Modify: `apps/gateway/src/config/web-search.ts`
- Test: `apps/gateway/src/__tests__/web-search-custom.test.ts`

**Interfaces:**
- Produces: `createCustomSource(configDir, input)`、`updateCustomSource(configDir, id, input)`、`deleteCustomSource(configDir, id)`（都返回 `WebSearchSettingsView`）；`CustomSearchSource { id; name; apiKeyEnc: string | null; endpoint: EndpointSourceSpec }`。

- [ ] **Step 1: 写失败测试**

```ts
const spec = { method: "POST", url: "https://s.example.com/search", bodyTemplate: '{"q":"{{query}}"}', paths: { list: "items", title: "title", url: "url" } };

it("creates, updates and deletes a custom source", async () => {
  let view = await createCustomSource(dir, { name: "我的搜索", apiKey: "k", endpoint: spec });
  expect(view.custom).toHaveLength(1);
  const id = view.custom[0]!.id;
  view = await updateCustomSource(dir, id, { name: "改名", endpoint: spec });
  expect(view.custom[0]!.name).toBe("改名");
  view = await deleteCustomSource(dir, id);
  expect(view.custom).toEqual([]);
});

it("falls back to auto when the deleted source was selected", async () => {
  const view = await createCustomSource(dir, { name: "S", endpoint: spec });
  const id = view.custom[0]!.id;
  await updateWebSearchConfig(dir, { source: id });
  const after = await deleteCustomSource(dir, id);
  expect(after.source).toBe("auto");
  expect(after.warnings.join()).toContain("已回落到");
});

it("rejects specs that cannot parse: bad method, non-http url, broken template, missing paths", async () => {
  await expect(createCustomSource(dir, { name: "S", endpoint: { ...spec, method: "PUT" } })).rejects.toThrow();
  await expect(createCustomSource(dir, { name: "S", endpoint: { ...spec, url: "file:///etc/passwd" } })).rejects.toThrow();
  await expect(createCustomSource(dir, { name: "S", endpoint: { ...spec, bodyTemplate: "{" } })).rejects.toThrow();
  await expect(createCustomSource(dir, { name: "S", endpoint: { ...spec, paths: { list: "items", title: "t", url: "" } } })).rejects.toThrow();
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm vitest run apps/gateway/src/__tests__/web-search-custom.test.ts`
Expected: FAIL。

- [ ] **Step 3: 实现**

id 由 name 生成 slug 并去重（如 `my-search`、`my-search-2`）；`createCustomSource` 校验 spec 并试渲染一次模板（用 `query: "test"`、`count: 5`）以证明合法；删除时若 `config.source === id` 则写回 `auto` 并在返回的 `warnings` 里加一条。

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm vitest run apps/gateway/src/__tests__/web-search-custom.test.ts`
Expected: PASS。

- [ ] **Step 5: 提交**

```bash
git add apps/gateway/src/config apps/gateway/src/__tests__
git commit -m "feat(gateway): manage custom search sources"
```

### Task 9: gateway — 源解析、wiring 与路由

**Files:**
- Modify: `apps/gateway/src/config/web-search.ts`（`resolveWebSearch`、`testWebSearch`）
- Modify: `apps/gateway/src/wiring.ts`（构建时解析并传给 `createAgent`）
- Modify: `apps/gateway/src/server.ts`（五条路由）
- Test: `apps/gateway/src/__tests__/web-search-routes.test.ts`

**Interfaces:**
- Consumes: Task 6 的 `webSearch` 选项、Task 7/8 的配置函数。
- Produces: `resolveWebSearch(config, ctx: { provider?: { id; piProvider; baseUrl; apiKey } | null }): { options: WebSearchToolOptions; warnings: string[] }`；`testWebSearch(configDir, opts: { source?; query?; providerId? }): Promise<{ resolved; durationMs; hits } | { resolved; error }>`。

- [ ] **Step 1: 写失败测试**

```ts
it("auto reuses a DeepSeek channel's key", async () => {
  const { options } = resolveWebSearch(defaults, { provider: { id: "ds", piProvider: "deepseek", baseUrl: null, apiKey: "k" } });
  expect(options).toMatchObject({ source: "deepseek", apiKey: "k" });
});
it("auto falls back to none for a non-DeepSeek channel", async () => {
  const { options } = resolveWebSearch(defaults, { provider: { id: "oa", piProvider: "openai", baseUrl: null, apiKey: "k" } });
  expect(options).toEqual({ source: "none" });
});
it("off never wires the tool", () => {
  expect(resolveWebSearch({ ...defaults, source: "off" }, {}).options).toEqual({ source: "off" });
});

it("GET /config/web-search masks keys and lists candidates", async () => {
  const res = await request("GET", "/config/web-search");
  expect(res.status).toBe(200);
  expect(res.body).toMatchObject({ source: "auto", custom: [] });
  expect(JSON.stringify(res.body)).not.toContain("sk-");
});

it("POST /config/web-search/test uses the same resolution as a session", async () => {
  const res = await request("POST", "/config/web-search/test", { query: "deepseek" });
  expect(res.body.resolved.sourceId).toBe("deepseek");
  expect(Array.isArray(res.body.hits)).toBe(true);
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm vitest run apps/gateway/src/__tests__/web-search-routes.test.ts`
Expected: FAIL。

- [ ] **Step 3: 实现**

`resolveWebSearch` 按 spec §5.3 的六条规则产出 `WebSearchToolOptions`（自定义 id → 找 `custom`；找不到 → `none` + warning）。`wiring.ts` 在 `loadEgressPolicy` 旁 `await loadWebSearchConfig(getConfigDir())` + 用 `opts.providerId` 查 provider store 得到 `{ piProvider, baseUrl, apiKey: await readApiKey(id) }`，把 `options` 作为 `webSearch` 传给 `createAgent`。路由：`GET/PUT /config/web-search`、`POST /config/web-search/custom`、`PUT|DELETE /config/web-search/custom/<id>`、`POST /config/web-search/test`；test 用 `createNodeNetwork()` + `wrapNetworkWithEgress`，`providerId` 缺省 `lastProviderId`。

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm turbo run build --filter @voltojs/tools --filter @voltojs/sdk --filter @voltojs/runtime-node && pnpm vitest run apps/gateway/src/__tests__/web-search-routes.test.ts`
Expected: PASS。

- [ ] **Step 5: 提交**

```bash
git add apps/gateway/src
git commit -m "feat(gateway): resolve web search source per session and expose routes"
```

### Task 10: web — 设置页内置源与解析结果显示

**Files:**
- Modify: `apps/web/lib/config-api.ts`（类型 + `fetchWebSearchSettings`、`updateWebSearchSettings`、`testWebSearch`）
- Create: `apps/web/components/settings/WebSearchCard.tsx`
- Modify: `apps/web/components/settings/ToolsPanel.tsx`（卡片置于浏览器卡片之上）
- Modify: `apps/web/messages/{zh,en}/settings.json`（`tools.webSearch.*`）
- Test: `apps/web/components/settings/__tests__/web-search-card.test.tsx`

**Interfaces:**
- Consumes: Task 9 的 HTTP 契约。
- Produces: `WebSearchCard()` 组件；`WebSearchSettingsView`、`CustomSearchSourceView`、`WebSearchTestResult` 前端类型。

- [ ] **Step 1: 写失败测试**

```tsx
it("shows the resolved source and saves a DeepSeek key", async () => {
  mockGet({ source: "auto", resolved: { sourceId: "deepseek", label: "DeepSeek", reason: "reuse-channel" }, builtins: { ... }, custom: [], candidates: [{ id: "ds", name: "DeepSeek", apiKeyMasked: "••••7890" }], warnings: [] });
  render(<WebSearchCard />);
  expect(await screen.findByText(/自动 → 复用 DeepSeek 渠道/)).toBeInTheDocument();
  await user.click(screen.getByRole("combobox", { name: /搜索源/ }));
  await user.click(screen.getByRole("option", { name: "DeepSeek" }));
  await user.click(screen.getByRole("radio", { name: /填写 API Key/ }));
  await user.type(screen.getByLabelText(/API Key/), "sk-new");
  await user.click(screen.getByRole("button", { name: /保存/ }));
  expect(postBody()).toMatchObject({ source: "deepseek", deepseek: { apiKey: "sk-new" } });
});

it("lists candidates and explains an empty list", async () => {
  mockGet({ ...base, candidates: [] });
  render(<WebSearchCard />);
  expect(await screen.findByText(/先去模型配置添加 DeepSeek 渠道/)).toBeInTheDocument();
});

it("shows the first three hits from a test search", async () => {
  mockPost({ resolved: { sourceId: "glm", label: "GLM" }, hits: [{ title: "A", url: "https://a" }, { title: "B", url: "https://b" }] });
  render(<WebSearchCard />);
  await user.click(screen.getByRole("button", { name: /测试/ }));
  expect(await screen.findByText("A")).toBeInTheDocument();
  expect(screen.queryByText("C")).not.toBeInTheDocument();
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm vitest run apps/web/components/settings/__tests__/web-search-card.test.tsx`
Expected: FAIL。

- [ ] **Step 3: 实现**

`WebSearchCard`：源 select（自动 / DeepSeek / Brave / GLM / 每个自定义源 / 关闭）、解析结果行、当前源的内置 key 槽（DeepSeek 额外「复用渠道」单选 + 渠道下拉）、保存与测试按钮、warnings 行。文案全部走 `useTranslations('settings')`。`ToolsPanel` 顶部渲染它。

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm vitest run apps/web/components/settings/__tests__/web-search-card.test.tsx apps/web/components/settings/__tests__/tools-panel.test.tsx`
Expected: PASS。

- [ ] **Step 5: 提交**

```bash
git add apps/web
git commit -m "feat(web): add web search settings card"
```

### Task 11: web — 自定义源表单与增删改

**Files:**
- Create: `apps/web/components/settings/CustomSearchSourceForm.tsx`
- Modify: `apps/web/components/settings/WebSearchCard.tsx`（列表、添加、编辑、删除）
- Modify: `apps/web/lib/config-api.ts`（`createCustomSource / updateCustomSource / deleteCustomSource`）
- Modify: `apps/web/messages/{zh,en}/settings.json`
- Test: `apps/web/components/settings/__tests__/custom-search-source-form.test.tsx`

**Interfaces:**
- Consumes: Task 8/9 的自定义源路由契约。
- Produces: `CustomSearchSourceForm({ value?, onSubmit, onCancel })`。

- [ ] **Step 1: 写失败测试**

```tsx
it("submits a POST spec with the template and mappings", async () => {
  render(<CustomSearchSourceForm onSubmit={onSubmit} onCancel={vi.fn()} />);
  await user.type(screen.getByLabelText(/名称/), "我的搜索");
  await user.type(screen.getByLabelText(/URL/), "https://s.example.com/search");
  await user.type(screen.getByLabelText(/请求体模板/), '{"q":"{{query}}","n":{{count}}}');
  await user.type(screen.getByLabelText(/结果列表路径/), "items");
  await user.type(screen.getByLabelText(/标题路径/), "title");
  await user.type(screen.getByLabelText(/链接路径/), "url");
  await user.type(screen.getByLabelText(/API Key/), "k");
  await user.click(screen.getByRole("button", { name: /保存/ }));
  expect(onSubmit).toHaveBeenCalledWith(expect.objectContaining({
    name: "我的搜索",
    endpoint: expect.objectContaining({ method: "POST", url: "https://s.example.com/search", paths: expect.objectContaining({ list: "items", title: "title", url: "url" }) }),
  }));
});

it("deletes a custom source after confirmation", async () => {
  mockGet({ ...base, source: "custom", custom: [{ id: "c1", name: "我的搜索", method: "POST", url: "https://s.example.com/search", apiKeyMasked: "••••1234" }] });
  render(<WebSearchCard />);
  await user.click(await screen.findByRole("button", { name: /删除 我的搜索/ }));
  await user.click(screen.getByRole("button", { name: /确认删除/ }));
  expect(deletedId()).toBe("c1");
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm vitest run apps/web/components/settings/__tests__/custom-search-source-form.test.tsx`
Expected: FAIL。

- [ ] **Step 3: 实现**

表单字段：名称、方法（GET/POST）、URL、鉴权头、前缀、额外 headers（JSON 文本，可选）、body 模板（POST 时显示）、映射六项、API Key（编辑时留空表示不改）。前端只做必填校验，形如渲染失败的判断留给服务端错误回显。删除走二次确认。

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm vitest run apps/web/components/settings/__tests__/custom-search-source-form.test.tsx`
Expected: PASS。

- [ ] **Step 5: 提交**

```bash
git add apps/web
git commit -m "feat(web): add custom search source editor"
```

### Task 12: web — 轨迹与卡片结构化展示

**Files:**
- Modify: `apps/web/lib/tool-summary.ts`
- Modify: `apps/web/components/chat/ToolCallCard.tsx`
- Modify: `apps/web/messages/{zh,en}/chat.json`
- Test: `apps/web/lib/__tests__/tool-summary.test.ts`（补用例）、`apps/web/components/chat/__tests__/tool-call-card-search.test.tsx`（新）

**Interfaces:**
- Consumes: Task 5 的 `ConversationToolCall.search`。

- [ ] **Step 1: 写失败测试**

```ts
it("summarises web_search with source and hit count", () => {
  expect(toolCallSummary("web_search", { query: "q" }, undefined, { sourceLabel: "GLM", count: 5 })).toBe("GLM · q（5 条）");
});
```
```tsx
it("renders each hit with its link and snippet", () => {
  render(<ToolCallCard call={{ id: "1", name: "web_search", args: { query: "q" }, result: "raw", search: { sourceId: "glm", sourceLabel: "GLM", query: "q", count: 2, durationMs: 210, hits: [
    { title: "A", url: "https://a.example", snippet: "SA" }, { title: "B", url: "https://b.example", snippet: "SB" } ] } }} />);
  expect(screen.getByRole("link", { name: "A" })).toHaveAttribute("href", "https://a.example");
  expect(screen.getByText("SB")).toBeInTheDocument();
  expect(screen.getByText(/GLM/)).toBeInTheDocument();
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm vitest run apps/web/lib/__tests__/tool-summary.test.ts apps/web/components/chat/__tests__/tool-call-card-search.test.tsx`
Expected: FAIL。

- [ ] **Step 3: 实现**

`toolCallSummary` 加第四个可选参数 `search?: { sourceLabel: string; count: number }`（现有调用点保持不变，缺省走原逻辑）。`ToolCallCard` 在有 `call.search` 时先渲染结果块：源与耗时徽标、query、逐条「标题（链接）— 摘要 — 日期」，超过 5 条折叠；原始参数区与原始结果区保留。

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm vitest run apps/web/lib/__tests__/tool-summary.test.ts apps/web/components/chat/__tests__/tool-call-card-search.test.tsx`
Expected: PASS。

- [ ] **Step 5: 提交**

```bash
git add apps/web
git commit -m "feat(web): show web search results in the tool card"
```

### Task 13: 文档与最终门禁

**Files:**
- Modify: `docs/user/reference/config-sections.json`（新增 `webSearch`）
- Modify: `docs/user/reference/tool-notes.json`（`web_search`）
- Create: `docs/user/using/guides/web-search.md`、`docs/user/zh/using/guides/web-search.md`
- Modify: `docs/user/README.md`（索引）
- Regenerate: `docs/user/using/reference/config.md`、`docs/user/using/reference/tools.md`、`docs/user/.meta/surface.json`（只经 `pnpm docs:gen`）

- [ ] **Step 1: 写 notes 与指南**

`config-sections.json` 的 `webSearch` 段：summary（中英）说明「搜索源单选、内置三家 + 自定义端点、key 加密存本地、配置在新会话生效」；fields 覆盖 `source`、`deepseek.sourceProviderId`、`deepseek.apiKeyEnc`、`brave.apiKeyEnc`、`glm.apiKeyEnc`、`custom`。
指南写：选源、DeepSeek 两种鉴权、GLM/Brave 填 key、自定义源示例（把 GLM 的 REST 端点写成模板）、auto 的退化顺序、egress 要放行哪些主机、未配置时的表现、生效时机。

- [ ] **Step 2: 生成并检查**

Run: `pnpm turbo run build && pnpm docs:gen && pnpm docs:check`
Expected: `docs:check` 无 error（新增表面已记录在 `docs/user/.meta/surface.json`）。

- [ ] **Step 3: 全量门禁**

Run: `pnpm turbo run typecheck lint test --filter '!@voltojs/desktop-app'`
Expected: 全绿。

- [ ] **Step 4: 手工验收**

1. `pnpm --filter @voltojs/gateway dev` 启动网关（或按仓库 README）。
2. 设置 → 工具配置 → 网页搜索：连一个 DeepSeek 渠道，选「自动」，点「测试搜索」→ 出现真实结果。
3. 切到 GLM（填 key），再测 → 结果来自 GLM。
4. 添加一个自定义源（用 GLM 的 REST 端点当模板），选中并测试 → 通过。
5. 把会话模型换成非 DeepSeek 渠道，新开会话 → `web_search` 仍在工具表里，调用返回「未配置搜索源」指引。
6. 任一搜索后打开轨迹/工具卡片 → 看到源、query、条数、逐条标题与链接。

- [ ] **Step 5: 提交**

```bash
git add docs
git commit -m "docs: document web search configuration"
```
