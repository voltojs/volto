# M8–M14 落地改进方案

> **类型**：改进计划（基于路线图落地审查）
> **版本**：1.0
> **日期**：2026-06-12
> **状态**：Draft（待评审）
> **关联**：路线图 [roadmap.md](./roadmap.md)、架构设计 [pure-volto.md](./pure-volto.md)

---

## 1. 背景

基于对 `docs/roadmap.md`、`plans/` 下全部 8 个方案文档、以及 monorepo 全量源代码的逐文件审查，发现代码库完成度远超预期——M1–M7 全面落地，M8–M14 的核心功能模块均有实质性实现。

主要差距不在"是否实现"而在**深度与集成度**：端口有适配器但 Runner 层自动集成未接线；Eval 有回放但缺录制；可观测性有 span 但缺 OTel 导出；宿主形态有骨架但缺真实平台集成。

本文档将改进项按优先级排序，逐项给出：当前状态、改进目标、技术方案、涉及文件、验收标准。

---

## 2. P0 — 必须立即修复

### 2.1 资源调速器接入真实 $ 定价表

**当前状态**：`maxCostDollars` 名为美元但实际比较的是 token 数（`runner.ts:210` `cumulativeCost += event.inputTokens + event.outputTokens`）。

**改进目标**：成本限制基于真实美元定价，与 `pricing` 表对齐。

**技术方案**：
- `RunnerOptions.pricing` 已存在（`Record<string, { inputPer1M, outputPer1M }>`）
- 在 `runModelStream()` 的 usage 事件处理中，用 `pricing[model]` 将 token 转为美元
- `cumulativeCost` 改为累加美元金额
- `checkBudgetLimits()` 中比较美元阈值

**涉及文件**：
- `packages/runtimes/node/src/runner.ts`（`cumulativeCost` 累加逻辑 + `checkBudgetLimits` 比较逻辑）
- `packages/core/src/state.ts`（字段注释更新 `maxCostDollars` 含义确认）

**验收标准**：
- 配置 `pricing: { "gpt-4o": { inputPer1M: 2.5, outputPer1M: 10 } }` + `maxCostDollars: 0.01`
- 执行一轮含模型调用的 turn，当实际美元成本超过 0.01 时，Runner 产出 `budget_exceeded` 事件并终止
- 单元测试覆盖：mock usage 事件验证累计美元计算正确

---

### 2.2 Eval 轨迹录制器

**当前状态**：`trajectory.ts` 仅有 `createTrajectory` + `addStep` 手动接口，无法从真实会话自动录制。

**改进目标**：提供 `TrajectoryRecorder`，在 Runner 层拦截 (input, state, effects) 三元组，自动生成可重放的 Trajectory。

**技术方案**：
- 新建 `packages/eval/src/recorder.ts`
- 实现 `TrajectoryRecorder` 类：
  - `start(name, stepContext)` — 开始录制
  - `capture(input, state, effects)` — 每次 step() 后调用，追加到 trajectory
  - `stop()` — 结束录制，返回 `Trajectory` 对象
  - `toJSON()` / `fromJSON()` — 序列化/反序列化
- 在 `Runner` 或 `SDK` 层提供录制 hook（可选注入）
- 提供 `createRecordingRunner()` 包装器，自动在每次 feed() 后 capture

**涉及文件**：
- `packages/eval/src/recorder.ts`（新建）
- `packages/eval/src/index.ts`（导出）
- `packages/eval/src/__tests__/recorder.test.ts`（新建测试）

**验收标准**：
- `createTrajectoryRecorder()` + `capture()` 生成的 Trajectory 可直接传入 `replayTrajectory()` 并通过
- 支持 JSON 序列化/反序列化（录制 → 保存文件 → 加载 → 重放）
- 测试覆盖：录制一个含 user_message → model_done → tool_result → model_done 的完整 turn，验证轨迹完整性

---

### 2.3 自纠回环集成到 Runner

**当前状态**：`self-correct.ts` 定义了 `decideSelfCorrect` + `Validator`，但 Runner 未调用。

**改进目标**：Runner 在 tool_result 后可选触发校验 → 修复循环，受 `maxSelfCorrections` 限制。

**技术方案**：
- `RunnerOptions` 新增可选字段：
  - `validators?: Validator[]` — 注册的校验器
  - `selfCorrectionMax?: number` — 最大自纠次数（默认 0 = 不启用）
- 在 `executeTool()` 返回 result 后，遍历 validators：
  - 若 `validation.passed === false` 且 `selfCorrectionCount < max`：
    - 构造 `SelfCorrectDecision.repairPrompt` 作为 user_message 注入
    - 递增 `state.selfCorrectionCount`
    - 继续循环（模型收到修复指令）
  - 若预算耗尽，将 repairPrompt 作为最终 tool_result 的 error 信息回喂
- `reducer.ts` 已有 `selfCorrectionCount` + `maxSelfCorrections` 字段，无需改动核心

**涉及文件**：
- `packages/runtimes/node/src/runner.ts`（`executeTool()` 后增加校验-修复逻辑）
- `packages/runtimes/node/src/__tests__/runner-self-correct.test.ts`（新建测试）

**验收标准**：
- 配置 `validators: [createSchemaValidator(["status"])]` + `selfCorrectionMax: 2`
- 工具返回非法 JSON → Runner 自动注入修复 prompt → 模型重新调用 → 第二次仍失败 → 停止并回喂最终错误
- `state.selfCorrectionCount` 正确递增
- 测试覆盖：验证 0/1/2/3 次修复的行为差异

---

## 3. P1 — 近期应完成

### 3.1 Anthropic cache_control 翻译

**当前状态**：`ModelRequest.cacheBreakpoints` 已定义，但 Anthropic provider 未翻译为 `cache_control` header。

**改进目标**：Anthropic provider 在 `cacheBreakpoints` 对应的 message 上添加 `cache_control: { type: "ephemeral" }`。

**技术方案**：
- `packages/providers/anthropic/src/model-port.ts` 的 `buildRequestBody()` 中：
  - 遍历 `messages` 数组
  - 若当前 index 在 `cacheBreakpoints` 中，为该 message 添加 `cache_control` 字段
- OpenAI 自动前缀缓存，无需翻译（breakpoints 仅作诊断）

**涉及文件**：
- `packages/providers/anthropic/src/model-port.ts`（`buildRequestBody` 函数）

**验收标准**：
- 构造含 `cacheBreakpoints: [0, 2]` 的请求，验证发出的 HTTP body 中第 0 和第 2 条 message 包含 `cache_control`
- 单元测试覆盖

---

### 3.2 RAG Pipeline Runner 集成

**当前状态**：`retrieval.ts` 仅计算注入位置，Runner 未调用 MemoryStore/Embedder 做实际检索。

**改进目标**：Runner 在模型调用前自动执行 RAG 检索并注入结果。

**技术方案**：
- `RunnerOptions` 新增可选字段：
  - `rag?: { memoryStore: MemoryStore; embedder?: Embedder; topK?: number; queryBuilder?: (state) => string }`
- 在 `runModelStream()` 构建 request 前：
  - 调用 `rag.queryBuilder(state)` 获取查询文本（默认取最后一条 user message）
  - 调用 `memoryStore.query(query, topK)` 获取检索片段
  - 调用 `computeRAGInjectionIndex(cacheBreakpoints, messages.length)` 获取注入位置
  - 在该位置插入 `buildRAGMessage(fragments)` 构造的 synthetic user message

**涉及文件**：
- `packages/runtimes/node/src/runner.ts`（`runModelStream()` 中增加 RAG 注入步骤）
- `packages/runtimes/node/src/__tests__/runner-rag.test.ts`（新建测试）

**验收标准**：
- 配置 RAG 后，模型请求的 messages 数组中包含检索片段
- 检索片段位于静态前缀之后（不破坏 cache breakpoints）
- 无 RAG 配置时行为不变

---

### 3.3 OTel Exporter Adapter

**当前状态**：`InMemoryTelemetry` 仅记录 span/metric 到内存，无外部导出。

**改进目标**：提供 `OtelTelemetry` adapter，将 span/metric 导出为 OTLP 格式。

**技术方案**：
- 新建 `packages/runtimes/node/src/otel-telemetry.ts`
- 实现 `Telemetry` 接口：
  - `startSpan()` — 创建 span，`end()` 时推入导出队列
  - `metric()` — 推入导出队列
- 使用 `fetch` 向 OTLP HTTP endpoint 发送 JSON 格式的 span/metric
- 批量导出（buffer + flush on interval or threshold）
- 不引入 `@opentelemetry/*` 依赖（保持轻量，直接构造 OTLP JSON）

**涉及文件**：
- `packages/runtimes/node/src/otel-telemetry.ts`（新建）
- `packages/runtimes/node/src/__tests__/otel-telemetry.test.ts`（新建测试）

**验收标准**：
- 创建 `OtelTelemetry({ endpoint: "http://localhost:4318" })`，运行一个含模型调用的 turn
- 验证导出的 span 包含 `turn` / `model_call` / `tool_execute` 三级
- 验证 `cost_usd` / `tokens` / `latency_ms` 指标被导出

---

### 3.4 错误重试指数退避 + 熔断

**当前状态**：`classifyError` 分类了 transient/rate_limited，但 Runner 中 retriable model_error 仅简单重试。

**改进目标**：Runner 对 retriable 错误实现指数退避 + 连续失败熔断。

**技术方案**：
- `RunnerOptions` 新增可选字段：
  - `retryPolicy?: { maxRetries?: number; baseDelayMs?: number; maxDelayMs?: number; circuitBreakerThreshold?: number }`
- 在 `runModelStream()` 的 catch 块中：
  - 若 `classification.retriable` 且 `retryCount < maxRetries`：
    - 等待 `min(baseDelayMs * 2^retryCount, maxDelayMs)` 后重试
    - 递增 `retryCount`
  - 若连续失败达 `circuitBreakerThreshold`（默认 5）：
    - 产出 `model_error` + `retriable: false`，停止重试
    - 重置计数器（熔断恢复需等下一轮）

**涉及文件**：
- `packages/runtimes/node/src/runner.ts`（`runModelStream()` 增加重试逻辑）
- `packages/runtimes/node/src/__tests__/runner-retry.test.ts`（新建测试）

**验收标准**：
- 配置 `retryPolicy: { maxRetries: 3, baseDelayMs: 100 }`
- mock ModelPort 第 1-2 次抛 transient error，第 3 次成功 → 验证重试次数和延迟递增
- mock ModelPort 连续 5 次失败 → 验证熔断触发，第 6 次不再重试

---

### 3.5 Browser Runtime 端到端验证

**当前状态**：`runtimes/browser/` 提供 FileSystem/Network/Tokenizer adapter，但未验证核心包在纯 browser 环境下运行。

**改进目标**：编写端到端测试，证明 `@volto/core` + browser adapter 在无 node 依赖下完整运行一个 turn。

**技术方案**：
- 新建 `packages/runtimes/browser/src/__tests__/e2e.test.ts`
- 使用 vitest 的 `browser` mode（或 jsdom 模拟）
- 组装：`createBrowserFileSystem` + `createBrowserNetwork` + `createBrowserTokenizer`
- 创建 `createAgent({ modelPort: mockPort, fs, network, ... })`
- 执行 `agent.run("list files")` → 验证完整 turn 完成
- **验证 `@volto/core` 包的 import 中无 `node:*`**（可用 eslint/no-restricted-imports 规则自动化）

**涉及文件**：
- `packages/runtimes/browser/src/__tests__/e2e.test.ts`（新建）

**验收标准**：
- 测试在 browser-like 环境下通过
- `packages/core/` 的所有 import 无 `node:*` 依赖

---

## 4. P2 — 中期规划

### 4.1 Gemini Provider

**目标**：实现 Gemini API 的 ModelPort adapter，支持流式 + tool_use + reasoning。

**技术方案**：
- 新建 `packages/providers/gemini/`
- 参照 OpenAI/Anthropic 的 `stream-normalize.ts` 模式
- Gemini 使用 `/v1beta/models/{model}:streamGenerateContent` 端点
- SSE 格式与 OpenAI/Anthropic 不同，需独立的 `normalizeStream()`
- 与现有 mock 脚本重放测试等价

**涉及文件**：
- `packages/providers/gemini/src/model-port.ts`（新建）
- `packages/providers/gemini/src/stream-normalize.ts`（新建）
- `packages/providers/gemini/src/__tests__/`（新建）

**验收标准**：
- 同一 mock 脚本通过 OpenAI / Anthropic / Gemini 三个 provider 重放等价
- 支持 `responseFormat: { type: "json" }` 的 JSON 模式

---

### 4.2 AST/Tree-sitter 结构化编辑

**目标**：提供基于 AST 的结构化编辑工具（insert/delete/replace node）。

**技术方案**：
- 新建 `packages/tools/ast/`
- 依赖 `tree-sitter` + 语言 grammars（可选 peerDependencies）
- 工具集：`ast_query`（查询节点）/ `ast_insert`（插入节点）/ `ast_replace`（替换节点）/ `ast_delete`（删除节点）
- 按 capability 门控（缺 tree-sitter 时不可见）

**验收标准**：
- 配置 tree-sitter + TypeScript grammar 后，`ast_query` 返回结构化节点列表
- `ast_replace` 可精确定位并替换函数定义

---

### 4.3 Skills 运行时加载

**目标**：Skills 可从文件系统发现并按需加载到 system prompt。

**技术方案**：
- `RunnerOptions` 或 `CreateAgentOptions` 新增 `skillsDir?: string`
- Runner 在 turn 开始时扫描 `skillsDir` 下的 `*.md` 文件
- 匹配用户输入与 skill 的 `trigger` 字段（`findTriggeredSkills()`）
- 匹配的 skill 资源内容注入为 system message 的追加段

**涉及文件**：
- `packages/sdk/src/create-agent.ts`（增加 skillsDir 解析）
- `packages/sdk/src/skills.ts`（增加 loadSkillsFromFileSystem）

**验收标准**：
- 配置 `skillsDir: ".agents/skills/"`，用户输入匹配 skill trigger → 该 skill 内容出现在 system prompt 中
- 不匹配时 system prompt 不变

---

### 4.4 MCP 资源/Prompt 暴露为工具

**目标**：MCP server 的 resources 和 prompts 自动注册为 agent 可调用的工具。

**技术方案**：
- `McpToolSource.list()` 中：
  - 除了 native tools，还遍历 `connection.resources` 和 `connection.prompts`
  - 为每个 resource 生成 `mcp__<serverId>__read_resource_<name>` 工具
  - 为每个 prompt 生成 `mcp__<serverId>__get_prompt_<name>` 工具
- 这些工具的 handler 调用 `connection.readResource()` / `connection.getPrompt()`

**涉及文件**：
- `packages/tools/mcp/src/mcp-tool-source.ts`（`list()` 方法扩展）
- `packages/tools/mcp/src/connection.ts`（需缓存 discovered resources/prompts）

**验收标准**：
- MCP server 声明 resource + prompt 后，对应工具出现在 agent 可见集中
- 调用 `mcp__srv__read_resource_foo` 返回 resource 内容

---

### 4.5 IDE Extension VS Code API 集成

**目标**：将 `extension.ts` 从 HTTP 客户端升级为真正的 VS Code 扩展。

**技术方案**：
- 使用 VS Code Extension API：
  - `vscode.commands.registerCommand("volto.run", ...)` 注册命令
  - `vscode.window.createOutputChannel("Agent Core")` 用于日志
  - `vscode.window.createWebviewPanel` 用于聊天 UI
  - Language Server Protocol 集成用于 LSP 工具
- JetBrains 支持通过 LSP 代理实现

**涉及文件**：
- `apps/ide-extension/src/extension.ts`（重写为 VS Code API 集成）
- `apps/ide-extension/package.json`（VS Code 扩展清单）

---

### 4.6 Promise.allSettled 替换

**目标**：并行工具执行使用 `Promise.allSettled` 确保所有结果收集。

**技术方案**：
- `runner.ts:601` `Promise.all(parallelBatch.map(...))` → `Promise.allSettled(parallelBatch.map(...))`
- 遍历结果时，`rejected` 的标记为 `isError: true`

**涉及文件**：
- `packages/runtimes/node/src/runner.ts`（6 行改动）

**验收标准**：
- 3 个并行工具中 1 个 reject → 其余 2 个结果正常回喂，reject 的标记为 error

---

## 5. P3 — 远期规划

### 5.1 编排拓扑扩展

**目标**：新增 map-reduce / debate / router 拓扑。

**技术方案**：
- `core/orchestration.ts` 新增 `TopologyKind = "pipeline" | "supervisor" | "map-reduce" | "debate" | "router"`
- `sdk/orchestration.ts` 为每种拓扑实现执行逻辑
- router 拓扑：supervisor 输出解析为路由指令，分发到对应 worker

### 5.2 审计日志持久化

**目标**：提供文件/数据库持久化的 AuditSink。

**技术方案**：
- 新建 `FileAuditSink`（追加写入 JSONL 文件）
- 新建 `SqliteAuditSink`（写入 SQLite 表）

### 5.3 Chat Adapter 真实集成

**目标**：Slack / Discord 真实 API 集成。

**技术方案**：
- 基于 `@slack/bolt` 实现 Slack adapter
- 基于 `discord.js` 实现 Discord adapter
- 通过 `ChatPlatform` 接口抽象

---

## 6. 实施路线图

```
Phase 1（P0，1-2 周）:
  ├── 2.1 资源调速器定价表
  ├── 2.2 Eval 轨迹录制器
  └── 2.3 自纠回环 Runner 集成

Phase 2（P1，2-3 周）:
  ├── 3.1 Anthropic cache_control
  ├── 3.2 RAG Pipeline
  ├── 3.3 OTel Exporter
  ├── 3.4 错误退避 + 熔断
  └── 3.5 Browser Runtime 验证

Phase 3（P2，3-4 周）:
  ├── 4.1 Gemini Provider
  ├── 4.2 AST 结构化编辑
  ├── 4.3 Skills 运行时加载
  ├── 4.4 MCP 资源暴露
  ├── 4.5 IDE Extension
  └── 4.6 Promise.allSettled

Phase 4（P3，按需）:
  ├── 5.1 编排拓扑扩展
  ├── 5.2 审计日志持久化
  └── 5.3 Chat Adapter 真实集成
```

---

## 7. 依赖关系

```
2.1 定价表 ─── 无依赖，可立即开始
2.2 录制器 ─── 依赖 eval 包现有 trajectory.ts
2.3 自纠回环 ── 依赖 self-correct.ts（已存在）
3.1 cache_control ── 依赖 anthropic provider（已存在）
3.2 RAG Pipeline ── 依赖 MemoryStore + Embedder（已存在）+ retrieval.ts（已存在）
3.3 OTel ──── 依赖 Telemetry 端口（已存在）
3.4 退避熔断 ── 依赖 error-taxonomy.ts（已存在）
3.5 Browser ── 依赖 runtimes/browser/（已存在）
4.1 Gemini ── 依赖 provider 模式（已建立）
4.2 AST ──── 无强依赖，需 tree-sitter peerDep
4.3 Skills ── 依赖 skills.ts（已存在）+ M9 指令加载机制
4.4 MCP ──── 依赖 mcp-tool-source.ts（已存在）
4.5 IDE ──── 依赖 headless-server（已存在）
4.6 allSettled ── 无依赖
```
