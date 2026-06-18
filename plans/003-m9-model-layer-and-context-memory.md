# Plan 003 — M9 模型与推理层 + 上下文/记忆

> **Status**: Done
> **Owner**: TBD
> **Created**: 2026-06-09
> **Depends on**: 演进路线图 [docs/roadmap.md](../docs/roadmap.md) M9；架构设计 [docs/pure-volto.md](../docs/pure-volto.md)；Plan 001（M1–M7 已交付）；Plan 002（M8 — 9 个端口契约 + SDK 兜底，本 Plan 消费其中 4 个）
> **Target area**: `packages/providers/{anthropic,openai}/src/*`、`packages/embedders/*`、`packages/memories/*`（新的 `MemoryStore` 实现包，**区别于既有 `packages/stores/memory` 的 SessionStore**）、`packages/core/src/{context-assembler,compactor,instructions,retrieval,index}.ts`、`packages/sdk/src/{create-agent,defaults,model-router,cost-meter}.ts`

## 1. 背景

### 1.1 问题陈述

M1–M7 的模型层只有单一 OpenAI 兼容 `ModelPort`（`/v1/chat/completions` 流式归一化为 text/reasoning/tool_use/usage 事件），上下文层只有 `ContextAssembler`（system 前缀稳定化）+ `Compactor`（纯压缩决策）+ `Tokenizer`。M8 又仅落了 `MemoryStore` / `Embedder` / `Cache` / `Telemetry` 等端口的**纯类型契约 + SDK 兜底**，没有真实实现，也没有任何上层逻辑消费它们。

要兑现 [roadmap](../docs/roadmap.md) M9「解锁广度」的定调，本 Plan 需要把两条工作流落到真实运行路径：

- **WS-3 模型与推理层**：原生 Anthropic provider（thinking / tool_use 块归一化）+ 多 provider 归一化复用既有 `ModelEvent` 形态；模型路由 / 回退；Prompt/上下文缓存接线（消费 M8 `Cache` 端口 + provider 侧 `cache_control` + `ContextAssembler` 缓存提示）；reasoning 透传；结构化 / JSON 输出模式；成本计量与定价表（账目 / 上报）。
- **WS-4 上下文与记忆**：项目指令分层加载（`CLAUDE.md` / `AGENTS.md` 发现 + `@import` 递归展开，注入为可缓存静态前缀）；检索增强上下文（RAG）注入；分层记忆（工作 / 情景 / 语义，`MemoryStore` 真实实现）；上下文 pinning。

全程守住立身之本：核心包内决策仍为纯函数（缓存标记 / pinning / RAG 选片在 `ContextAssembler` / `Compactor` 内只做**纯决策**，真实缓存读写与向量检索经 `Cache` / `Embedder` / `MemoryStore` 端口由 Runner / SDK 执行）；多 provider 一律归一化为既有 `ModelEvent`；`@volto/core` 仍零运行时依赖；`zod` 只出现在 `tools/*` 与 `sdk`。

### 1.2 现状审计

| 维度 | 当前实现 | 目标状态 |
|---|---|---|
| Provider | 仅 OpenAI 兼容（`model-port.ts` + `stream-normalize.ts`），归一化 text/reasoning/tool_use/usage/done/error | 新增原生 Anthropic provider，thinking → `reasoning_delta`、tool_use 块 → `tool_use_*`、usage（含 cache 读写 token）归一化为同一 `ModelEvent`；切换 provider 重放等价 |
| 模型路由 | 无；`createAgent` 注入单个 `modelPort` | SDK 侧 `ModelRouter`：按角色（主推理 / compaction / 分类 / embedding）选 provider+model，可配置回退链；归一化错误触发回退 |
| Prompt 缓存 | `ContextAssembler` 仅算 `staticPrefixLength` / `computeStaticPrefixTokens`（诊断用），无真实缓存命中 | 纯核心产出缓存断点提示（cache breakpoint）；provider 翻译为 `cache_control`；`Cache` 端口承载响应级缓存；usage 暴露 cache hit |
| reasoning | `reasoning_delta` 已归一化但无透传策略 | reasoning 透传可配（流出 EventSink / 写入历史 / 仅计费），跨 provider 一致 |
| 结构化输出 | 无；只有自由文本 + tool_use | provider 层 JSON / response_format 模式 + 最终答案 schema 约束（schema 经 sdk/zod，核心只认 `JSONSchema`） |
| 成本计量 | usage 事件有 token，无 $ 账目 | 定价表 + `CostMeter`：每 turn 聚合 token 与 $，经 EventSink / Telemetry 流出（**账目/上报，不做强制**） |
| Embedder | M8 端口纯类型，SDK 兜底（无真实 embed） | 真实 `Embedder` 实现包（消费端口，OpenAI/Anthropic 兼容 embeddings API） |
| 指令加载 | 无；system prompt 由宿主手动拼 | `CLAUDE.md` / `AGENTS.md` 分层发现 + `@import` 递归展开（纯解析在核心 / sdk，文件读经 FileSystem 端口），注入为可缓存静态前缀 |
| RAG | 无 | 纯核心选片决策（把检索片段放在前缀之后的稳定槽位）+ SDK 检索（Embedder→MemoryStore.query）；注入不破坏前缀稳定性 |
| 记忆 | M8 `MemoryStore` 端口纯类型 + 内存兜底（无分层语义） | 分层记忆真实实现（工作 / 情景 / 语义），消费 `MemoryStore` + `Embedder` 端口 |
| pinning | 无；`Compactor` 仅按 file-path / todo 启发式保留 | `ContextAssembler` / `Compactor` 纯决策识别 pinned 消息，永不被压缩、稳定置于前缀槽位 |

### 1.3 设计目标

1. **多 provider 归一化等价**：所有 provider 输出收敛到既有 `ModelEvent`；同一 mock 脚本切换 provider 重放 (state, effects) deep-equal。
2. **核心仍纯**：缓存断点 / pinning / RAG 选片 / 指令解析全部为纯决策或纯数据变换；真实缓存读写、向量检索、文件发现经端口由 Runner / SDK 执行。
3. **缓存前缀稳定**：指令注入与 RAG 注入都不得破坏静态前缀的字节稳定性——变量内容只能追加在前缀之后的确定槽位。
4. **消费而非重定义端口**：`Cache` / `Embedder` / `MemoryStore` / `Telemetry` 端口类型由 M8 owns，本 Plan 只实现 adapter 与上层消费逻辑，**绝不在 core 重新定义这些端口**。
5. **账目而非强制**：成本计量只产出账目与事件上报；预算「强制」越限终止已由 M8 Phase 4 落地，本 Plan 不重复实现。
6. **向后兼容**：现有仅 `modelPort` 的最小配置零回归；未启用缓存 / RAG / 记忆时行为与现状一致。

## 2. Goals

1. 新增 `@volto/provider-anthropic`：原生 Messages API 流式，thinking / tool_use / usage（含 cache token）归一化为既有 `ModelEvent`，错误归一为 `ModelEventError`（不抛异常）。
2. SDK 侧 `ModelRouter`：按角色选 provider+model + 可配置回退链；归一化错误（`retriable`）驱动回退。
3. Prompt/上下文缓存：`ContextAssembler` 纯产出缓存断点提示；provider 翻译为 `cache_control`；响应级缓存经 M8 `Cache` 端口；usage 暴露 cache hit / cache write token。
4. reasoning 透传策略可配（EventSink / 历史 / 仅计费），跨 provider 一致。
5. 结构化 / JSON 输出：provider 层模式开关 + 最终答案 schema 约束（schema 在 sdk 用 zod，核心只传 `JSONSchema`）。
6. 成本计量：定价表 + `CostMeter`，每 turn 聚合 token 与 $，经 EventSink / Telemetry 端口流出。
7. 项目指令分层加载：发现 `CLAUDE.md` / `AGENTS.md` + 递归展开 `@import`（防环 / 防越界），注入为可缓存静态前缀。
8. RAG：纯核心选片 + SDK 检索（Embedder→MemoryStore），注入不破坏前缀稳定性。
9. 分层记忆：消费 `MemoryStore` + `Embedder` 端口的真实实现（工作 / 情景 / 语义）。
10. 上下文 pinning：`ContextAssembler` / `Compactor` 纯决策保护 pinned 消息。
11. `@volto/core` 仍零运行时依赖（`check-core-zero-deps` 通过）；`pnpm turbo run typecheck lint test` 全绿 + 既有重放测试不回归。

## 3. Non-Goals

1. **不**重新定义 M8 已 owns 的端口类型（`Cache` / `Embedder` / `MemoryStore` / `Telemetry` 等）——只实现 adapter 与消费逻辑。
2. **不**做预算「强制」越限终止（M8 Phase 4 已落地）；本 Plan 只做成本账目 / 上报。
3. **不**实现校验-修复（validate-fix）自纠回环（归 Plan 005 / M11）；结构化输出仅做模式开关 + schema 约束，schema 校验失败的修复循环不在本 Plan。
4. **不**新增 / 改动工具（MCP 客户端、apply_patch、LSP 等归 Plan 004 / M10）。
5. **不**实现沙箱 / secrets / 调度等其余 M8 端口的 adapter（归 Plan 005+）。
6. **不**实现多 agent 编排拓扑、OTel 导出后端（归 Plan 006 / M12；本 Plan 只把成本 metric 喂给 `Telemetry` 端口，导出由 M12）。
7. **不**引入 `Date.now()` / 随机 / `node:*` 进 `packages/core`（时间 / 随机 / ID 仍走 port；文件发现走 FileSystem 端口）。
8. **不**实现 reasoning `record` 策略（需改造 reducer 将 reasoning_delta 写入 AssistantMessage，牵涉核心状态类型）；本 Plan 仅实现 `emit` 和 `meter-only` 两种策略，`record` 留后续 Plan。

## 4. Key decisions

### 4.1 多 provider：归一化为既有 ModelEvent，不扩事件形态

**决策**：原生 Anthropic provider 把 Messages API 流式 SSE 翻译为既有 `ModelEvent`——`content_block_delta(thinking)` → `reasoning_delta`、`content_block_start(tool_use)` + `input_json_delta` → `tool_use_start` + `tool_use_delta`、`message_delta.usage` / `message_start.usage` → `usage`（含 `cache_creation_input_tokens` / `cache_read_input_tokens` 折算）、`message_stop` → `done`。`ModelEvent` 形态保持不变（usage 的 cache 读写 token 字段由 M8 在 `ModelEventUsage` 预置，本 Plan 直接消费，见 4.3）。

**理由**：核心与 Runner 已围绕 `ModelEvent` 闭环（reducer 累积 text/tool_use、Runner 透传 EventSink），归一化复用既有形态让「切 provider = 换 adapter」成立，且重放等价天然可测；扩事件形态会波及 reducer 与所有既有测试，违背可移植承诺。第三方 SSE 分片累积细节（Anthropic `input_json_delta` 累积、OpenAI `tool_calls` 分片）须查官方文档确认，不凭记忆。

### 4.2 模型路由 / 回退：SDK 编排，core 不感知

**决策**：`ModelRouter` 落在 SDK（`packages/sdk/src/model-router.ts`），按**角色**（`main` 主推理 / `compaction` / `classify` / `embedding`）映射到 `{ provider, model }`，并持有有序回退链；当某 provider 流出 `ModelEventError{ retriable: true }` 时按链回退到下一个。core 仍只见单一 `ModelPort` 抽象——Router 对外暴露为一个满足 `ModelPort` 的复合实现。

**理由**：路由是宿主编排关注点，不是纯状态机的决策；把它留在 SDK 让 core 零改动、可移植不破。复合为单一 `ModelPort` 让 Runner / reducer 完全无感，回退发生在 adapter 边界内，重放仍由归一化事件序列决定。对比「core 内裁决路由」：会让 reducer 背上 provider 列表与成本事实，接口变重且破纯度，否决。

### 4.3 Prompt 缓存:核心产缓存断点(纯决策),端口/provider 执行

**决策**：分两层。**前缀缓存（provider 原生）**——`ContextAssembler` 纯函数在静态前缀（system / 指令 / 工具定义边界）产出 `cacheBreakpoints`（消息索引 + 稳定 key，纯数据），provider 把断点翻译为 Anthropic `cache_control: { type: "ephemeral" }`（OpenAI 自动前缀缓存则忽略断点）；usage 归一化时暴露 cache hit / write token。**响应级缓存（M8 Cache 端口）**——对确定性子调用（如 compaction summary、分类）按请求内容 hash 经 `Cache` 端口 get/set，命中则跳过模型调用（读写在 Runner / SDK，非 core）。`ModelEventUsage` 的可选字段 `cacheReadTokens?` / `cacheWriteTokens?` 由 M8（Plan 002 Phase 1）预置，本 Plan 直接消费、**不在 core 改动端口/事件类型**。

**理由**：缓存命中是 I/O 事实，必须在端口 / provider 侧；但「哪里是稳定断点」是确定性决策，放纯核心既守纯度又让断点随消息结构可重放。响应级缓存复用 M8 `Cache` 端口（消费而非重定义），命中跳过仍归一为同样的事件序列以保重放。

### 4.4 指令分层加载:纯解析在核心,文件发现在端口

**决策**：`@import` 递归展开与分层合并是**纯文本变换**，落在 `packages/core/src/instructions.ts`（纯函数：输入「路径→内容」映射 + 入口路径，输出展开后的指令文本 + 引用图）；真实文件**发现与读取**经 FileSystem 端口由 SDK / Runner 完成后喂给纯函数。展开结果作为 system 静态前缀注入（参与 4.3 缓存断点）。防环（已访问集合）、防越界（限定根目录内）、缺失 import 降级为可见占位而非抛错。

**理由**：纯解析可单测、可重放、可缓存；把 `fs` 留在端口守纯度铁律。分层合并顺序遵循全局 < 项目优先级（与既有 `~/.claude` + 项目 `AGENTS.md` 约定一致）。注入为静态前缀让其享受 prompt 缓存。

### 4.5 RAG 注入:纯选片 + 稳定槽位,不污染前缀

**决策**：检索（embed query → `MemoryStore.query(text, k)`）在 SDK / Runner 经 `Embedder` + `MemoryStore` 端口执行；纯核心只负责**把检索片段放进确定槽位**——位于静态前缀（system/指令/工具）**之后**、对话变量内容之前的一个稳定「检索上下文」区，且不改写前缀字节。RAG 片段本身随 query 变化，因此排在缓存断点之后，保证前缀仍命中缓存。

**理由**：验收明确要求「RAG 注入不破坏静态前缀稳定性（仍可缓存）」。把变量片段排在断点之后是唯一能同时拿到 RAG 与缓存命中的布局；检索是 I/O，留端口。

### 4.6 分层记忆:三层语义,复用 MemoryStore + Embedder

**决策**：新增独立包 `packages/memories/inmemory`（`@volto/memory-inmemory`，首个 `MemoryStore` 实现；后续可加向量/持久化实现于同一 `packages/memories/` 目录），实现三层：**工作记忆**（当前会话窗口，已由 state.messages 承载，记忆层只做摘要锚点）、**情景记忆**（按会话 / 时间归档的 turn 摘要）、**语义记忆**（embedding 索引的长期事实）。三层统一经 M8 `MemoryStore` 接口存取（`save` / `query` / `delete`），语义层额外消费 `Embedder`。层级是实现内部约定（如 entry 上的 `tier` 字段），不扩端口签名。

> **与 SessionStore 严格区分**：`MemoryStore`（语义召回）与既有 `packages/stores/memory` 的 `SessionStore`（会话快照 / checkpoint）是**两个不同端口、两个不同包**。本 Plan **不触碰** `packages/stores/memory`，分层记忆一律落在新的 `packages/memories/`，避免概念混淆与跨 Plan 包归属碰撞。

**理由**：M8 `MemoryStore` 端口已是最小契约，分层用 entry 元数据表达即可，避免重定义端口；独立成包让记忆实现与 SessionStore（M14 还会扩 sqlite/pg）互不耦合。RAG（4.5）直接复用语义层的 `query`。

### 4.7 上下文 pinning:纯标记 + Compactor/Assembler 保护

**决策**：pinned 状态以可序列化标记表达（消息上的 `pinned?: true` 或 state 上的 `pinnedMessageIds`，随 checkpoint 持久化）。`Compactor` 把 pinned 消息并入「永不压缩」集合（与既有 file-path / todo 的 `isKeyMessage` 同级）；`ContextAssembler` 把 pinned 内容稳定置于前缀槽位。全为纯决策。

**理由**：复用 `Compactor` 既有「key message 永不压缩」机制，最小侵入；标记入可序列化状态保证 resume 后 pinning 不丢、重放一致。

### 4.8 成本计量:账目 + 上报,不强制

**决策**：定价表（`{ provider, model } → { inputPer1M, outputPer1M, cacheReadPer1M, cacheWritePer1M }`，纯数据）+ SDK `CostMeter`：消费归一化 usage 事件，每 turn 聚合 token 与 $，经 EventSink（面向用户 / 日志）与 M8 `Telemetry` 端口（结构化 metric）流出。**不**触发任何终止。

**理由**：归属边界明确——预算强制归 M8（已做），本 Plan 只做账目 / 上报。定价表为纯数据便于离线测试与重放（成本来自确定的 token 计数 × 表）。

### 4.9 与其它 Plan 的边界

> 本 Plan 是防重叠的局部事实源；与 [roadmap](../docs/roadmap.md) §「跨 Plan 归属」一致。

**消费的 M8 端口（Plan 002 owns 类型，本 Plan 只实现 adapter / 消费逻辑，绝不重定义）**：

| M8 端口 | 本 Plan 如何消费 |
|---|---|
| `Cache` | 响应级缓存（compaction / 分类子调用按内容 hash get/set，见 4.3） |
| `Embedder` | 真实实现包 + 语义记忆 / RAG 的 query embedding（见 4.5 / 4.6） |
| `MemoryStore` | 分层记忆三层统一存取 + RAG 检索源（见 4.5 / 4.6） |
| `Telemetry` | 成本 metric 上报（见 4.8；导出后端归 M12） |

**明确 excludes（归兄弟 Plan，本 Plan 不碰）**：

- 校验-修复（validate-fix）自纠回环 → Plan 005 / M11（本 Plan 仅做结构化输出模式 + schema 约束，不做失败重试循环）。
- 任何工具新增 / 改动（MCP 客户端、LSP、apply_patch、multi_edit、notebook 等）→ Plan 004 / M10。
- 预算「强制」越限终止 → 已由 Plan 002 / M8 Phase 4 落地；本 Plan 只做成本账目 / 上报。
- 沙箱 / secrets / 调度 adapter、`Telemetry` 的 OTel 导出后端、多 agent 编排 → Plan 005 / 006。

## 5. 实现计划

> Phase 1（Anthropic provider）打底多 provider 与归一化，是路由 / 缓存的前置；Phase 2（路由 + reasoning + 结构化 + 成本）在 SDK 编排层叠加，复用 Phase 1 的归一化事件；Phase 3（指令加载 + pinning）是纯核心上下文增强，独立于模型层；Phase 4（缓存接线）跨 provider + ContextAssembler + Cache 端口；Phase 5（Embedder + 分层记忆 + RAG）落上下文检索。严格串行、逐 Phase review + 单独 commit。

### Phase 1: 原生 Anthropic provider + 多 provider 归一化等价

**Goal**: 新增 `@volto/provider-anthropic`，Messages API 流式 thinking / tool_use / usage 归一化为既有 `ModelEvent`；同一 mock 脚本切 provider 重放等价。

**Files covered**:
- `packages/providers/anthropic/`（新包：`package.json` / `tsconfig` / `src/{index,model-port,stream-normalize}.ts`）
- 对应 `__tests__/`（含跨 provider 重放等价测试）

> 注：`ModelEventUsage` 的 `cacheReadTokens?` / `cacheWriteTokens?` 字段由 **M8（Plan 002 Phase 1）** 在 `packages/core/src/ports.ts` 预置；本 Plan **不改 core 端口/事件类型**，仅在各 provider 归一化时填充这些字段。

**Tasks**:
- [x] 查 Anthropic Messages API 流式官方文档，确认 `message_start` / `content_block_start|delta|stop`（text / thinking / tool_use+`input_json_delta` 累积）/ `message_delta`（usage / stop_reason）/ `message_stop` 事件序列
- [x] 实现 `createAnthropicModelPort`：SSE 解析 + `normalizeStream` 翻译为既有 `ModelEvent`（thinking→`reasoning_delta`、tool_use→`tool_use_*`、usage 含 cache token 折算、stop→`done`）
- [x] 错误归一为 `ModelEventError`（含 `retriable` 标注 5xx/429），abort 归一为 `error`（不抛异常）
- [x] 在 Anthropic / OpenAI 两个 provider 的 usage 归一化中填充 M8 预置的 `cacheReadTokens?` / `cacheWriteTokens?`（无则 undefined）；**不改 core 类型定义**
- [x] 测试：录制 Anthropic SSE 分片 → 断言归一化事件序列；同一抽象 mock 脚本分别走 OpenAI / Anthropic provider，断言 (state, effects) deep-equal

**Acceptance Criteria**:
1. Anthropic provider 把 thinking / tool_use（含 `input_json_delta` 分片累积）/ usage 正确归一化为既有 `ModelEvent`，无新事件类型，且不改 core（cache 字段由 M8 预置，仅填充）。
2. 同一 mock 脚本切换 OpenAI / Anthropic provider，重放 (state, effects) 序列 deep-equal（**provider 切换重放等价**）。
3. provider 错误 / abort 一律归一为 `ModelEventError`，**不抛异常中断主循环**。
4. `@volto/core` 仍零依赖（`check-core-zero-deps` 通过）；既有 OpenAI 测试零回归。

<!-- Backfill after execution:
**Reviewed**: 2026-06-09 by reviewer
**Commit**: 30a9101 feat(plan-003): phase 1 - 原生 Anthropic provider + 多 provider 归一化等价
-->

---

### Phase 2: 模型路由/回退 + reasoning 透传 + 结构化输出 + 成本计量

**Goal**: SDK 侧 `ModelRouter`（按角色选 provider+model + 回退链）；reasoning 透传可配；结构化 / JSON 输出模式；定价表 + `CostMeter` 账目上报。

**Files covered**:
- `packages/sdk/src/model-router.ts`（新增，复合为单一 `ModelPort`）
- `packages/sdk/src/cost-meter.ts`（新增，定价表 + 聚合）
- `packages/sdk/src/create-agent.ts`（接入 router / cost / reasoning / structured 配置）
- `packages/providers/{anthropic,openai}/src/model-port.ts`（结构化输出模式：`response_format` / JSON 模式 + 最终答案 `JSONSchema` 约束）
- 对应 `__tests__/`

**Tasks**:
- [x] `ModelRouter`：primary + 有序回退链，对外满足 `ModelPort`；`ModelEventError{ retriable }` 驱动按链回退；网络异常亦视为 retriable
- [x] reasoning 透传策略：EventSink wrapper 按 `reasoningStrategy` 过滤（`emit` 透传 / `meter-only` 丢弃 reasoning_delta）；`record` 需核心改造，留后续 Phase
- [x] 结构化输出：`responseFormat` 经 `StepContext` → runner → `ModelRequest` 接线；OpenAI `json_schema` / Anthropic system instruction；core 只认 `JSONSchema`
- [x] 定价表（纯数据）+ `CostMeter`：消费 `model_done` usage 每 turn 聚合 token 与 $，经 EventSink + `Telemetry` 流出（**不触发终止**）
- [x] 测试：路由 primary/fallback/retriable/non-retriable（6 tests）；成本聚合 + cache + EventSink emission（9 tests）；既有 SDK 测试零回归

**Acceptance Criteria**:
1. **路由**：低成本模型跑 compaction / 分类、强模型跑主推理；回退链可配置，首选 `retriable` 失败时自动回退。
2. 结构化 / JSON 模式产出可解析结构化结果；schema 经 sdk/zod，core 仅见 `JSONSchema`（zod 不入 core）。
3. **成本计量**：每 turn 聚合 token 与 $（含 cache 读写折算），可经 EventSink / Telemetry 流出；不触发任何终止（账目/上报，强制归 M8）。
4. reasoning 透传三策略跨 provider 行为一致；既有最小配置（单 modelPort，无 router）零回归。

<!-- Backfill after execution:
**Reviewed**: 2026-06-09 by reviewer (PASS after P1/P2 fixes)
**Commit**: a5589d4 feat(plan-003): phase 2 - 模型路由/回退 + reasoning 透传 + 结构化输出 + 成本计量
-->

---

### Phase 3: 项目指令分层加载（@import 递归）+ 上下文 pinning

**Goal**: 发现并递归展开 `CLAUDE.md` / `AGENTS.md`（防环 / 防越界），注入为可缓存静态前缀；pinned 消息永不压缩、稳定置于前缀槽位（纯决策）。

**Files covered**:
- `packages/core/src/instructions.ts`（新增纯函数：`@import` 递归展开 + 分层合并 + 引用图）
- `packages/core/src/state.ts`（`pinnedMessageIds?` 或消息 `pinned?` 标记，可序列化）
- `packages/core/src/compactor.ts`（pinned 并入永不压缩集合）
- `packages/core/src/context-assembler.ts`（pinned 稳定置于前缀槽位）
- `packages/core/src/index.ts`（导出）
- `packages/sdk/src/create-agent.ts`（经 FileSystem 端口发现 + 读取指令文件后喂纯函数）
- 对应 `__tests__/`

**Tasks**:
- [x] `instructions.ts` 纯函数：输入「路径→内容」映射 + 入口路径，递归展开 `@import`，输出展开文本 + 引用图；已访问集合防环；限定根目录防越界；缺失 import 降级为可见占位
- [x] 分层合并：全局 < 项目优先级；展开结果作为 system 静态前缀（参与 Phase 4 缓存断点）
- [x] SDK：经 FileSystem 端口发现 `CLAUDE.md` / `AGENTS.md`（从 cwd 向上 / 全局目录）+ 读取，再调纯函数（`fs` 留端口，不入 core）
- [x] pinning：state 加 `pinnedMessageIds`（可序列化，survives resume）；`Compactor` 纳入永不压缩集合；`ContextAssembler` 把 pinned 稳定排进前缀槽位
- [x] 测试：多层 @import 递归展开正确（6 tests）；循环 import 不死锁、越界 import 被拒、缺失 import 降级；pinned 消息在压缩后仍保留且位置稳定；重放等价

**Acceptance Criteria**:
1. **指令加载**：发现项目层级指令文件并递归展开 `@import`（防环 / 防越界 / 缺失降级），注入为可缓存静态前缀。
2. pinned 消息永不被 `Compactor` 压缩，且在 `ContextAssembler` 中位置稳定；标记随 checkpoint 持久化、resume 后不丢。
3. 指令解析 / 合并 / pinning 全为纯函数无 I/O（文件读经 FileSystem 端口）；`check-core-zero-deps` 通过；含 import / pinning 的重放测试 deep-equal。

<!-- Backfill after execution:
**Reviewed**: 2026-06-09 by reviewer
**Commit**: 3f7172c feat(plan-003): phase 3 - 项目指令分层加载 + 上下文 pinning
-->

---

### Phase 4: Prompt/上下文缓存接线（缓存断点 + cache_control + Cache 端口）

**Goal**: `ContextAssembler` 纯产出缓存断点；provider 翻译为 `cache_control`；响应级缓存经 M8 `Cache` 端口；启用缓存时静态前缀命中、usage 暴露 cache hit。

**Files covered**:
- `packages/core/src/context-assembler.ts`（`cacheBreakpoints` 纯产出）
- `packages/providers/anthropic/src/model-port.ts`（断点 → `cache_control: ephemeral`）
- `packages/providers/openai/src/model-port.ts`（前缀自动缓存：断点用于诊断，usage 折算 cache token）
- `packages/sdk/src/create-agent.ts` / Runner 接线（响应级缓存经 `Cache` 端口 get/set）
- 对应 `__tests__/`

**Tasks**:
- [x] `ContextAssembler`：在静态前缀（system / 展开后指令 / 工具定义边界）产出 `cacheBreakpoints`（消息索引 + 稳定 key，纯数据）；RAG / 变量内容排在断点之后（与 Phase 5 槽位一致）
- [x] Anthropic provider：把断点翻译为请求体 `cache_control: { type: "ephemeral" }`；归一化 usage 暴露 `cacheReadTokens` / `cacheWriteTokens`
- [x] OpenAI provider：自动前缀缓存场景下断点仅用于诊断，usage 折算 cache token（按官方字段）
- [x] 响应级缓存：对确定性子调用（compaction summary / 分类）按请求内容 hash 经 `Cache` 端口 get/set，命中跳过模型调用但归一为同样事件序列（读写在 Runner / SDK）
- [x] 测试：重复请求静态前缀命中（mock usage 显示 cache read token / 成本下降）；指令变更使前缀失效；RAG 注入后前缀断点字节不变（仍命中）；响应级缓存命中跳过调用且重放等价

**Acceptance Criteria**:
1. **启用缓存时静态前缀命中**：mock provider usage 显示 cache read token > 0 / 成本下降；前缀字节稳定时命中、变更时失效。
2. **RAG 注入不破坏前缀稳定性**：检索片段排在缓存断点之后，前缀断点字节不变、仍可缓存（与 Phase 5 联调验证）。
3. 响应级缓存（`Cache` 端口）命中时跳过模型调用，归一化事件序列与未命中一致，重放 deep-equal。
4. `ContextAssembler` 断点产出为纯函数；core 零依赖不破；Cache 读写仅在 Runner / SDK。

<!-- Backfill after execution:
**Reviewed**: 2026-06-09 by reviewer
**Commit**: ad1e665 feat(plan-003): phase 4 - Prompt/上下文缓存接线
-->

---

### Phase 5: Embedder 实现 + 分层记忆 + RAG 注入

**Goal**: 真实 `Embedder` 实现包；分层记忆（工作 / 情景 / 语义）消费 `MemoryStore` + `Embedder`；RAG 纯选片 + SDK 检索，注入不破坏前缀稳定性。

**Files covered**:
- `packages/embedders/`（新包 `@volto/embedder-openai`：消费 M8 `Embedder` 端口）
- `packages/memories/inmemory/`（**新包** `@volto/memory-inmemory`：分层记忆三层 tier 元数据 + query；区别于既有 `stores/memory` 的 SessionStore，本 Plan 不碰后者）
- `packages/core/src/retrieval.ts`（新增纯函数：RAG 片段排进稳定槽位的选片决策）
- `packages/core/src/context-assembler.ts`（检索区槽位接入，断点之后）
- `packages/sdk/src/create-agent.ts` / Runner（embed query → MemoryStore.query → 注入；记忆写入 turn 摘要）
- 对应 `__tests__/`

**Tasks**:
- [x] `@volto/embedder-openai`：实现 M8 `Embedder.embed(texts)`（OpenAI 兼容 embeddings API），错误归一不抛异常
- [x] 分层记忆：新包 `@volto/memory-inmemory` 实现 `MemoryStore`，entry 带 tier（工作 / 情景 / 语义）元数据；语义层经 `Embedder` 索引；`query(text, k)` 跨层检索；情景层归档 turn 摘要（**不修改 `stores/memory`**）
- [x] `retrieval.ts` 纯函数：给定检索片段，产出注入位置 = 静态前缀缓存断点**之后**、对话变量之前的稳定槽位（不改写前缀字节）
- [x] SDK / Runner：检索流程（embed query → `MemoryStore.query` → 纯选片 → 注入）；记忆写入（turn 结束写情景 / 语义）经端口
- [x] 测试：Embedder smoke（5 tests: 创建 / 空输入 / 网络失败 / HTTP 错误 / 正常解析）；分层记忆 save/query/delete + tier 过滤（5 tests）;RAG 注入后静态前缀断点不变(联动 Phase 4 验收 2);检索为 I/O 在端口、选片为纯函数(5 tests);含 RAG 的重放等价(固定 mock embedding)

**Acceptance Criteria**:
1. `Embedder` 真实实现消费 M8 端口（**不重定义端口类型**），embed 错误归一不抛异常。
2. 分层记忆三层经 `MemoryStore` 接口存取（tier 元数据表达，不扩端口签名）；语义层检索复用 `Embedder`。
3. **RAG 注入不破坏静态前缀稳定性**：检索片段排在缓存断点之后，前缀仍命中缓存（与 Phase 4 联合验证）；选片为纯函数、检索为端口 I/O。
4. 含 RAG（固定 mock embedding）的输入序列两次运行 (state, effects) deep-equal。

<!-- Backfill after execution:
**Reviewed**: 2026-06-09 by reviewer
**Commit**: bf81a79 feat(plan-003): phase 5 - Embedder 实现 + 分层记忆 + RAG 注入
-->

---

## 6. Risks and mitigations

| Risk | Impact | Mitigation |
|---|---|---|
| Anthropic SSE 分片累积凭记忆臆测 | tool_use / thinking 归一化错误、流式断裂 | 查官方 Messages API streaming 文档确认事件序列与 `input_json_delta` 累积；录制 SSE 分片做归一化单测 |
| provider 切换破坏重放等价 | 「换 adapter 即换环境」承诺失效 | 所有 provider 收敛到既有 `ModelEvent`；跨 provider 同 mock 脚本重放 deep-equal 作回归门 |
| RAG / 指令注入污染静态前缀 | 缓存命中率骤降、成本上升 | 变量内容（RAG / 对话）一律排在缓存断点之后；断点字节稳定性测试 + RAG 联调验证（Phase 4 AC2 / Phase 5 AC3） |
| 缓存命中破坏可重放 | bug 不可复现、重放失效 | 响应级缓存命中归一为与未命中相同的事件序列；缓存读写仅在 Runner / SDK，断点产出为纯函数 |
| `@import` 递归环 / 路径越界 | 死循环 / 读到根目录外文件 | 纯函数内已访问集合防环、限定根目录防越界、缺失 import 降级为占位不抛错 |
| 在 core 误引入 fs / 时间做指令发现或记忆 | 破坏纯度 / 零依赖 | 文件发现 / 向量检索 / 缓存读写全在端口（FileSystem / Embedder / MemoryStore / Cache），core 只做纯解析与选片；core lint 纯度规则 + `check-core-zero-deps` 把关 |
| 重定义 M8 端口致与 Plan 002 冲突 | 端口契约分裂、后续 adapter 返工 | 本 Plan 只 import M8 端口类型 + 实现 adapter / 消费逻辑，绝不在 core 改 `Cache` / `Embedder` / `MemoryStore` / `Telemetry` 签名（§4.9 边界为准） |
| 成本计量误做成预算强制 | 与 M8 Phase 4 职责重叠 | 明确 `CostMeter` 只聚合 + 经 EventSink/Telemetry 上报，不触发任何终止（§4.8） |
| 结构化输出滑向校验-修复 loop | 越界侵占 Plan 005 范围 | 本 Plan 仅做模式开关 + `JSONSchema` 约束；schema 校验失败的自纠循环明确归 M11 |
| zod 渗入 core | 破坏依赖单向 / 核心纯抽象 | 结构化输出 schema 在 sdk 用 zod 推导，core 只接收 `JSONSchema`；lint 依赖规则把关 |
| Embedder 端口签名无 error channel | `embed()` 返回 `Promise<number[][]>`，错误只能 throw，与"不抛异常"AC 表面矛盾 | M8 `Embedder` 端口设计遗留问题；throw 由 Runner 在系统边界 catch 并归一化为 `ModelError` input，行为等价于不中断主循环；后续 Plan 可在端口加 `EmbedResult` 类型（含 error 字段）彻底解决 |

---

## Test Cases

### TC-001: Anthropic provider 流式归一化 — text / thinking / tool_use / usage

- **Preconditions**: `@volto/provider-anthropic` 包已构建，vitest 可运行
- **Steps**:
  1. 构造 Anthropic SSE 事件序列（message_start → content_block_start(text) → content_block_delta(text_delta) → content_block_stop → message_delta(stop_reason) → message_stop）
  2. 调用 `normalizeStream()`，收集产出事件
  3. 断言：text_delta 事件内容正确、done 事件 stopReason 正确、usage 事件 inputTokens/outputTokens 正确
  4. 同样构造含 thinking + tool_use 的序列，断言 reasoning_delta 和 tool_use_start/delta 正确
- **Paths**: `packages/providers/anthropic/src/__tests__/stream-normalize.test.ts:39-155`
- **Expected**: 15 个测试全部通过；事件序列与 Mock 脚本预期完全一致

### TC-002: 跨 provider 重放等价 — OpenAI ↔ Anthropic 输出 deep-equal

- **Preconditions**: OpenAI 和 Anthropic provider 包均已构建
- **Steps**:
  1. 构造同一逻辑对话脚本的 OpenAI RawStreamChunk 序列和 Anthropic RawAnthropicEvent 序列
  2. 分别调用 `normalizeStream()` 归一化
  3. 断言两组输出 `expect(ant).toEqual(oai)` deep-equal
  4. 覆盖场景：text-only、tool_use、reasoning+text、parallel tool calls
- **Paths**: `packages/providers/anthropic/src/__tests__/replay-equivalence.test.ts:43-183`
- **Expected**: 4 个测试全部通过；两 provider 归一化输出完全一致

### TC-003: ModelRouter 透明回退 — retriable error 触发 fallback

- **Preconditions**: `@volto/sdk` 已构建
- **Steps**:
  1. 创建 primary ModelPort 返回 `{ type: "error", retriable: true }`
  2. 创建 fallback ModelPort 返回 `{ type: "text_delta", text: "fallback" }` + `{ type: "done" }`
  3. 创建 `createModelRouter({ primary, fallbacks: [fallback] })`
  4. 调用 `router.stream()`，收集事件
  5. 断言：输出包含 fallback 的 text_delta 和 done 事件
- **Paths**: `packages/sdk/src/__tests__/model-router.test.ts:55-80`
- **Expected**: 6 个测试全部通过；retriable error 自动回退到次选 provider

### TC-004: CostMeter 聚合 + 定价计算 — token 累加与 $ 折算

- **Preconditions**: `@volto/sdk` 已构建
- **Steps**:
  1. 创建 CostMeter，pricing 为 `test-model: { inputPer1M: 3, outputPer1M: 15, cacheReadPer1M: 0.3, cacheWritePer1M: 3.75 }`
  2. 调用 `meter.record()` 两次，分别注入 usage 事件
  3. 调用 `meter.result()`，断言 inputTokens/outputTokens 正确累加
  4. 断言 totalCost 按 pricing table 正确折算（$3.0 × 1M input + $15.0 × 1M output = $18.0）
  5. 断言 EventSink 收到 `cost_summary` 事件
- **Paths**: `packages/sdk/src/__tests__/cost-meter.test.ts:43-105`
- **Expected**: 9 个测试全部通过；成本计算与 pricing table 一致

### TC-005: `@import` 递归展开 — 防环 / 防越界 / 缺失降级

- **Preconditions**: `@volto/core` 已构建
- **Steps**:
  1. 构造 `fileContents` Map：`/a.md` 引用 `@./b.md`，`/b.md` 引用 `@./a.md`（循环）
  2. 调用 `expandInstructions(files, "/a.md", "/")`
  3. 断言输出包含 `[circular import: ...]`
  4. 构造越界 import（`@/etc/passwd`），断言输出包含 `[import out of scope: ...]`
  5. 构造缺失 import，断言输出包含 `[missing instruction file: ...]`
- **Paths**: `packages/core/src/__tests__/instructions.test.ts:30-62`
- **Expected**: 9 个测试全部通过；递归展开正确、防环/防越界/缺失降级均生效

### TC-006: 上下文 pinning — pinned 消息永不压缩 + 前缀槽位稳定

- **Preconditions**: `@volto/core` 已构建
- **Steps**:
  1. 构造 6 条消息，pin index 2（`pinnedMessageIds: ["2"]`）
  2. 调用 `decideCompaction(messages, { maxTokens: 30, recentKeepCount: 2, pinnedMessageIds: ["2"] })`
  3. 断言：pinned 消息不在 `compressibleMessages` 中
  4. 调用 `assembleContext({ messages, tools: [], pinnedMessageIds: ["2"] })`
  5. 断言：pinned 消息位于 system 之后、其他消息之前；`staticPrefixLength` 包含 pinned
- **Paths**: `packages/core/src/__tests__/compactor.test.ts:264-293`, `packages/core/src/__tests__/context-assembler.test.ts:118-152`
- **Expected**: compactor + assembler 各 1 个 pinning 测试通过；pinned 消息受保护且位置稳定

### TC-007: 分层记忆 — tier 过滤 + save/query/delete

- **Preconditions**: `@volto/memory-inmemory` 已构建
- **Steps**:
  1. 创建 `createInMemoryMemoryStore()`
  2. 调用 `saveWithTier(entry("episodic fact"), "episodic")` 和 `saveWithTier(entry("semantic fact"), "semantic")`
  3. 调用 `queryByTier("any", 10, "episodic")`，断言返回 1 条且 text 为 "episodic fact"
  4. 调用 `queryByTier("any", 10, "semantic")`，断言返回 1 条且 text 为 "semantic fact"
  5. 调用 `queryByTier("any", 10)`（不指定 tier），断言返回 2 条
  6. 调用 `delete(id)`，断言 `query` 返回 0 条
- **Paths**: `packages/memories/inmemory/src/__tests__/memory.test.ts:54-88`
- **Expected**: 5 个测试全部通过；tier 过滤、CRUD 操作正确

### TC-008: cacheBreakpoints — 静态前缀产出 + Anthropic cache_control 翻译

- **Preconditions**: `@volto/core` 已构建
- **Steps**:
  1. 构造 messages：2 条 system + 3 条 user（无 pinned）
  2. 调用 `assembleContext({ messages, tools: [] })`
  3. 断言：`cacheBreakpoints` 包含 `[0, 2]`（首条 + system 结束边界）
  4. 断言：`staticPrefixLength === 2`
  5. 将 breakpoints 传入 Anthropic `buildRequestBody()`，断言 system 字段为 content block 格式且含 `cache_control: { type: "ephemeral" }`
- **Paths**: `packages/core/src/context-assembler.ts:54-88`, `packages/providers/anthropic/src/model-port.ts:79-130`
- **Expected**: assembler 产出正确断点；Anthropic provider 正确翻译为 cache_control

### TC-009: RAG 注入不破坏前缀稳定性

- **Preconditions**: `@volto/core` 已构建
- **Steps**:
  1. 构造 messages：system + 3 条 user
  2. 调用 `assembleContext()`，记录 `cacheBreakpoints` 和 `staticPrefixLength`
  3. 调用 `computeRAGInjectionIndex(cacheBreakpoints, totalMessages)`
  4. 断言：注入索引位于最后一个断点之后
  5. 验证：注入 RAG 消息后重新调用 `assembleContext()`，断言 `cacheBreakpoints` 不变（前缀字节稳定）
- **Paths**: `packages/core/src/__tests__/retrieval.test.ts:7-22`, `packages/core/src/context-assembler.ts:54-88`
- **Expected**: RAG 注入点位于断点之后；前缀断点不受 RAG 内容影响

### TC-010: 全量回归 — check-core-zero-deps + typecheck/lint/test 全绿

- **Preconditions**: 所有包已安装依赖
- **Steps**:
  1. 运行 `node scripts/check-core-zero-deps.mjs`
  2. 运行 `pnpm turbo run typecheck lint test --filter @volto/core --filter @volto/sdk --filter @volto/provider-anthropic --filter @volto/provider-openai --filter @volto/runtime-node --filter @volto/memory-inmemory`
  3. 断言：所有任务成功，无 error TS 或 lint error
- **Paths**: `scripts/check-core-zero-deps.mjs`, 全量 CI 管道
- **Expected**: check-core-zero-deps PASS；30 tasks 全部 successful；0 个测试失败
