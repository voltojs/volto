# Plan 006 — M12 可观测性 + 编排进阶

> **Status**: Draft
> **Owner**: TBD
> **Created**: 2026-06-09
> **Depends on**: 演进路线图 [docs/roadmap.md](../docs/roadmap.md) M12；架构设计 [docs/pure-agent-core.md](../docs/pure-agent-core.md)；Plan 002（M8 内核引擎 + 9 端口契约，含 `Telemetry`）；Plan 001（M1–M7 已交付：EventSink / SessionStore / task 子 agent / 重放测试）
> **Target area**: `packages/runtimes/node/src/runner.ts`（span/指标埋点 + checkpoint 历史）、`packages/sdk/src/{create-agent,defaults}.ts`、`packages/sdk/src/{debugger,orchestration}/*`（新增）、`packages/stores/*`（checkpoint 历史只读扩展）、`apps/reference-cli`（消费 span/调试器/审计）

## 1. 背景

### 1.1 问题陈述

M8（Plan 002）已把内核升级为支持并行 / steering / 调速的编排引擎，并立了 9 个**纯类型端口契约**（含面向运维的 `Telemetry`），但全部为"零实现 + SDK no-op 兜底"。M9–M11 补齐了模型层、工具生态与安全可靠性。到 M12，内核具备生产能力但**对外不可观测、对内不可调试、对上不可编排**：

- **不可观测**：每 turn / 工具 / 模型调用没有结构化 span 与指标导出，运维无法定位延迟瓶颈、成本归因、错误链路；`Telemetry` 端口仍是 no-op。
- **不可调试**：核心是纯数据状态机、`SessionStore` 已能 checkpoint，但每个 session 只保留**一个**最新快照（`save` 按 `id` 覆盖），无法"回到第 3 个 turn 单步重看"——纯 + 可重放这一架构红利尚未兑现为产品级时间旅行调试器。
- **不可编排**：`task` 子 agent 仅能"父发一条指令 → 子返一段文本"，没有可声明式组合的多 agent 拓扑（supervisor / pipeline / map-reduce / debate / router），无法表达"主管分派—汇聚""流水线串接"等协作结构。
- **审批/高风险执行无审计**：HITL 审批决策与高风险工具执行散落在事件流里，没有结构化、可追溯的审计日志。

本 Plan 落地 M12 的两组能力：

- **WS-8 可观测性与运维**：实现 M8 `Telemetry` 端口的 OTel adapter（每 turn / 工具 / 模型调用 span）；成本 / 延迟 / token 指标导出；时间旅行调试器（任意 checkpoint 回退、单步、状态 diff）；审计日志（审批决策 + 高风险工具执行）。
- **WS-1 编排进阶**：把单一 `task` 子 agent 升级为可声明式组合的多 agent 编排拓扑（至少 supervisor + pipeline），建立在 M8 引擎与既有子 agent 上下文隔离机制之上。

### 1.2 现状审计

| 维度 | 当前实现 | 目标状态 |
|---|---|---|
| 遥测 | M8 立了 `Telemetry` 纯类型端口；SDK `defaults.ts` 仅 no-op；Runner 不调用 | OTel adapter 实现 `Telemetry`；Runner 在 turn / 工具 / 模型调用边界开关 span，可导出 OTel |
| 指标 | 仅 EventSink 面向用户的 token/usage 事件；无结构化成本/延迟指标 | Runner 经 `Telemetry.metric` 导出成本$ / 延迟 ms / token 计数（含归因到 turn / 工具 / 模型） |
| checkpoint 历史 | `SessionStore.save(snapshot)` 按 `id` 覆盖，每 session 仅存最新快照（runner.ts:425） | 在不改 `SessionStore` 端口的前提下，新增**每 turn checkpoint 历史**记录（追加式），支持回退到任一 turn |
| 时间旅行 | 无；核心已是纯数据 + 重放等价（M1）红利未兑现 | 调试器：列出 checkpoints → 回退到任一 → 从该状态单步重放（复用 `step`）→ 与后续状态 diff |
| 审计 | 审批决策 / 高风险执行仅在事件流，无结构化审计记录 | 结构化审计日志：所有 `approval_decision` + `WRITE_HIGH`/`IRREVERSIBLE` 工具执行落审计条目 |
| 多 agent 编排 | 仅 `task`（父→子单条指令→单段文本，见 tools/agent/task.ts + create-agent.ts:466 `createSubAgentExecutor`） | 声明式拓扑（supervisor / pipeline / map-reduce / debate / router 至少前两种），子 agent 隔离复用既有机制、结果可聚合 |

### 1.3 设计目标

1. **核心零改动可观测**：span / 指标埋点全部落在 **Runner（imperative shell）**与 SDK，核心 reducer 不感知遥测、不碰 I/O、不破纯度；`Telemetry` 经端口注入。
2. **吃尽纯 + 可重放红利**：时间旅行调试器基于既有"核心纯数据快照 + `step` 重放等价"，回退/单步不引入任何新核心机制——只新增"checkpoint 历史"这一存取层与一个纯函数 `diffState`。
3. **不重做引擎、不重定义端口**：编排拓扑构建在 M8 引擎（并行 / 调速）+ 既有子 agent 隔离之上；`Telemetry` 沿用 M8 端口签名，本 Plan 只实现 adapter、不改类型。
4. **声明式可组合**：拓扑以纯数据规格（spec）声明，由 SDK 编排器实例化为子 agent 协作；拓扑的**纯决策部分**（如 router 的路由选择、supervisor 的分派裁决若做成确定性）放 core 且可重放。
5. **审计可追溯、不中断循环**：审计条目作为结构化数据经 `Telemetry` / 专用 sink 流出，不改变主循环控制流，错误不抛异常。
6. **向后兼容**：未注入 `Telemetry` / 未启用调试器 / 未声明拓扑时，行为与现状完全一致；既有测试零回归。

## 2. Goals

1. 实现 OTel `Telemetry` adapter（`packages/sdk` 或新 `packages/telemetry-otel`），Runner 在每 turn / 工具调用 / 模型调用边界开关 span（含错误状态、属性），可导出到 OTel collector。
2. 成本 / 延迟 / token 指标：Runner 经 `Telemetry.metric` 导出 per-turn / per-tool / per-model 的延迟 ms、token 计数、成本$（成本来自归一化 usage × 单价配置），不破纯度。
3. checkpoint 历史：在不改 `SessionStore` 端口契约下，新增追加式每-turn checkpoint 历史；时间旅行调试器可列出某 session 全部 checkpoints、回退到任一、从该状态用 `step` 单步重放、并与任一后续状态做结构化 diff。
4. 审计日志：所有审批决策（`approval_decision`）与高风险工具执行（`WRITE_HIGH` / `IRREVERSIBLE`）落结构化审计条目，可经专用 sink / `Telemetry` 导出。
5. 多 agent 编排：提供声明式拓扑规格 + SDK 编排器，至少落地 **supervisor + pipeline** 两种拓扑，可声明式组合；子 agent 上下文隔离复用既有 `createSubAgentExecutor` 机制，结果可聚合回主流程。
6. 全程满足验收 + `pnpm turbo run typecheck lint test` 通过 + `check-core-zero-deps` 通过 + 既有重放测试不回归。

## 3. Non-Goals

1. **不**重新定义 M8 的 `Telemetry` 端口类型或任何端口契约（M8 已定义；本 Plan 只实现 adapter / 消费）。
2. **不**重做 M8 内核引擎（并行 / steering / 调速 / 循环检测已在 M8 落地）；编排拓扑建立其上，不复制其逻辑。
3. **不**实现重放式 eval / 轨迹回归 harness（归 M11）。**时间旅行调试器是交互式回放工具**（人工回退/单步/diff），与 eval 的"自动断言一致性"职责不同，二者共享底层重放能力但目标互斥（见 §4 边界一节）。
4. **不**实现 map-reduce / debate / router 三种拓扑的完整生产形态（本 Plan 仅在规格层为其预留可扩展点，落地 supervisor + pipeline 即满足验收；其余拓扑可后续追加）。
5. **不**引入可视化 UI / 调试器前端；调试器为程序化 API + CLI 文本交互，渲染交给宿主。
6. **不**改变现有工具包、provider、store 的对外行为；checkpoint 历史以**附加**方式实现，不破坏 `SessionStore` 现有合同测试。
7. **不**在核心 reducer 引入 `Date.now()` / OTel SDK / 隐式副作用（遥测时间/导出全在 Runner / adapter）。

## 4. Key decisions

### 4.1 遥测埋点位置：Runner / adapter，核心零感知

**决策**：所有 OTel span 开关、指标记录都在 **Runner（imperative shell）**完成——Runner 在进入 `calling_model` 时开 model span、派发 `execute_tool` 时开 tool span、turn 起止开 turn span，结束/出错时关闭并标注属性。`Telemetry` 端口由 SDK 经构造注入（缺省 no-op），OTel adapter 是 `Telemetry` 的一个实现。核心 reducer 完全不感知遥测。

**理由**：遥测本质是 I/O + wall-clock（span 时间戳、导出）。让核心背遥测会破坏纯度与可重放（与 M8 §4.3"时间/成本治理留 Runner"同源）。Runner 已是 effect 的唯一解释点，是天然的埋点边界；adapter 化保证"可缺席、可替换、可测"。

### 4.2 指标口径：延迟来自 Runner wall-clock，成本来自归一化 usage × 单价

**决策**：延迟 ms 由 Runner 用注入的 `Clock`（或 adapter 内部时钟）测量 span 起止差；token 计数来自既有归一化 `usage`（M2/M8）；成本$ = usage × 调用方配置的"模型单价表"（输入/输出分别计价）。三者经 `Telemetry.metric(name, value, attrs)` 导出，attrs 标注归因维度（`turnId` / `toolName` / `model`）。

**理由**：复用 M8 已归一化的 usage 与 M8 Runner 已承担的 wall-clock 治理，不在核心新增时间事实。单价表是配置而非核心逻辑，放 SDK / adapter 侧。

### 4.3 时间旅行：新增"checkpoint 历史"存取层 + 纯函数 diff，复用 `step` 重放

**决策**：现状 `SessionStore.save` 按 `id` 覆盖，每 session 仅一份快照——不足以支撑"回到第 N 个 turn"。本 Plan **不改 `SessionStore` 端口**，而是新增一个**追加式 checkpoint 历史**机制：Runner 在每个 turn 边界（done / waiting）除常规 `Checkpoint` 外，向"历史存储"追加一条带递增 `seq` 的 checkpoint（key = `sessionId#seq`，复用 `SessionStore` 的多 key 能力，或新增薄 `CheckpointHistory` 存取包）。调试器据此：① `list(sessionId)` 列出全部 checkpoint；② `rewindTo(seq)` 取该快照为初始状态；③ `stepForward(input)` 用核心纯函数 `step` 单步推进（不调真实 port，重放等价）；④ `diffState(a, b)` 纯函数产出结构化状态差异。

**理由**：核心是纯数据 + `step` 重放等价（M1 验收 3 已保证），时间旅行近乎"免费"——只缺"历史快照存取"与"状态 diff"两块纯/薄机制。不改 `SessionStore` 端口避免破坏其合同测试；追加式历史用现有多 key 存储能力即可，无需重定义端口。`diffState` 是纯函数，放 core（可重放、可测）。

> **跨 Plan 接缝（checkpoint 历史 keying）**：追加式历史依赖"同一 store 按 `sessionId#seq` 多 key 存取"这一能力。本 Plan 把该能力**固化进 `SessionStore` 合同测试**（core `testing/store-contract`），从而：① 既有 `store-memory` / `store-file` 必须通过；② **M14（Plan 008）新增的 `store-sqlite` / `store-postgres` 也须通过同一合同**，自动获得历史能力。排期上 M12 先定义该合同扩展，M14 的新 store 实现据此实现；M14 不重复定义历史机制，只满足合同。

### 4.4 时间旅行调试器 vs M11 eval harness：交互回放 vs 自动断言（边界澄清）

**决策**：二者共享同一底层红利（纯数据快照 + `step` 重放等价），但**职责严格互斥**：
- **eval harness（M11 / Plan 005）**：录制真实会话轨迹 → 对新核心版本**自动重放并断言** (state, effects) 一致 → CI 级回归门，失败给首个分歧点。面向"核心是否回归"。
- **时间旅行调试器（M12 / 本 Plan）**：对**单一已发生会话**，人工**回退到任一 turn、单步前进、查看状态 diff**。面向"这次跑为什么这样"。

**理由**：防止与 Plan 005 重叠。本 Plan 只做交互式回放 API + CLI，不做断言/回归框架；若需复用 eval 已有的轨迹格式则**消费**之，不重定义。

### 4.5 编排拓扑：声明式 spec + SDK 编排器，纯决策入核心、隔离复用既有机制

**决策**：拓扑以**纯数据规格**声明（spec：节点 = 子 agent 定义 prompt/tools/model/policy，边 = 数据流向 + 聚合方式），由 SDK 侧编排器解释为子 agent 实例 + 协作调度：
- **supervisor**：一个主管 agent 依据输入裁决分派给哪个/哪些 worker，汇聚其结果。
- **pipeline**：固定顺序串接，前一节点输出作为后一节点输入。
- 子 agent 隔离**直接复用** `createSubAgentExecutor`（独立 context / 工具集 / 共享 ModelPort，结果作为文本聚合）。
- 拓扑中**确定性的纯决策**（如 router 的路由匹配、pipeline 的固定串接顺序、聚合归并顺序）放 core 纯函数（可重放）；涉及"让模型裁决分派"的 supervisor 决策本质是一次子 agent 调用，仍走子 agent 机制，不在核心写非确定逻辑。

**理由**：roadmap 明确"编排拓扑 ← M8 引擎 + 现有子 agent"。spec 化使拓扑可组合、可序列化、可测；复用既有隔离机制不重做上下文隔离；并行分派吃 M8 并行执行能力。把"确定性归并/路由"放核心保证多 agent 协作仍可重放。

### 4.6 审计日志：结构化条目经专用 sink / Telemetry，旁路主循环

**决策**：在 Runner 解释 `approval_decision`（runner.ts:434）与执行 `WRITE_HIGH`/`IRREVERSIBLE` 工具（依 `toolDef.riskTier`）处，构造结构化审计条目（who/what/decision/riskTier/timestamp/result），经专用 `AuditSink`（或复用 `Telemetry`）旁路导出，**不进入 reducer、不改控制流**。

**理由**：审计是观测旁路，不应影响决策；放 Runner 埋点点与遥测同源；结构化条目便于后续合规留存。错误不抛、不中断循环（铁律 §3.3）。

### 4.7 与其它 Plan 的边界

> 本节是防重叠的硬约束，落地时逐条对照。

| 关注点 | 归属 | 本 Plan（M12 / 006）的处理 |
|---|---|---|
| `Telemetry` 端口**类型** | M8 / Plan 002 | **只实现 adapter + 消费**，绝不改/重定义端口签名 |
| 其余 8 个端口契约类型 | M8 / Plan 002 | 不触碰 |
| 内核引擎（并行 / steering / 调速 / 循环检测） | M8 / Plan 002 | 编排拓扑**建立其上**，不复制、不重做引擎逻辑 |
| 重放式 eval / 轨迹回归 harness | M11 / Plan 005 | **不实现**；本 Plan 做交互式时间旅行调试器（人工回退/单步/diff），与 eval 自动断言职责互斥（§4.4）；若有公共轨迹格式则消费不重定义 |
| 错误/重试 taxonomy、自纠回环、沙箱、guardrails | M11 / Plan 005 | 不触碰；审计仅**记录**高风险执行，不做拦截（拦截归权限/沙箱） |
| 调度后台任务（Scheduler） | M11 横切 / Plan 005 | 不触碰 |
| 子 agent 上下文隔离机制 | 既有（M7） | **复用** `createSubAgentExecutor`，不重写隔离 |
| `EventSink`（面向用户输出） | 既有（M1） | 不与 `Telemetry`（面向运维）混淆：审计/指标走 Telemetry/AuditSink，用户可见事件仍走 EventSink |
| 声明式 agent / 子 agent **规格通用化**、插件/hooks | M13 / Plan 007 | 本 Plan 的拓扑 spec 仅服务编排，不做通用插件规格；通用声明式规格归 M13 |

## 5. 实现计划

> Phase 1（OTel tracing）低耦合打底，验证 Telemetry adapter 注入链路；Phase 2（指标/成本）在 span 基础上叠加 metric 导出；Phase 3（审计日志）复用同一埋点边界；Phase 4（时间旅行调试器）吃纯/可重放红利、相对独立；Phase 5（编排拓扑）是最大上层能力，置于最后。严格串行、逐 Phase review + 单独 commit（遵循 `plan-execution-gate`）。

### Phase 1: OTel tracing —— 实现 Telemetry 端口 + Runner span 埋点

**Goal**: 实现 M8 `Telemetry` 端口的 OTel adapter；Runner 在每 turn / 工具调用 / 模型调用边界开关 span（含属性与错误状态），可导出到 OTel collector；核心零改动、未注入时行为不变。

**Files covered**:
- `packages/telemetry-otel/`（新增包 `@agent-core/telemetry-otel`：实现 `Telemetry`，依赖 `@opentelemetry/*`；type-import core）
- `packages/runtimes/node/src/runner.ts`（在 turn / `calling_model` / `execute_tool` 边界开关 span；注入 `telemetry?: Telemetry`）
- `packages/sdk/src/{create-agent,defaults}.ts`（可选注入 `telemetry`，缺省 no-op 兜底）
- 对应 `__tests__/`（用 in-memory / mock Telemetry 断言 span 序列）

**Tasks**:
- [ ] 新建 `@agent-core/telemetry-otel`：以 `@opentelemetry/api` + SDK 实现 `Telemetry`（`startSpan(name, attrs)` 返回可结束/标错的 handle；`metric(...)` 占位，Phase 2 充实）；查官方文档确认 span/tracer 构造姿势
- [ ] Runner：注入可选 `telemetry`；turn 起止开关 `turn` span；进入 `calling_model` 开 `model_call` span（attrs：model、token in/out 于关闭时补）、`execute_tool` 派发处开 `tool_execute` span（attrs：toolName、riskTier、isError）
- [ ] Runner：模型/工具错误时把 span 标为 error 状态并附错误信息；span 嵌套关系（turn ⊃ model/tool）正确
- [ ] SDK `defaults.ts` 提供 no-op `Telemetry` 兜底；`createAgent` 接受可选 `telemetry`
- [ ] 测试：mock Telemetry 断言一轮"含 N 个 tool_use"产生的 span 名称/嵌套/属性序列；未注入 telemetry 时 Runner 行为与现状 deep-equal（既有用例零回归）

**Acceptance Criteria**:
1. 一轮对话（含模型调用 + N 个工具调用）产出结构化 span：1 个 turn span 嵌套 ≥1 个 model span + N 个 tool span，属性含 model / toolName / riskTier / 错误状态。
2. OTel adapter 可把 span 导出到 OTel collector（用 in-memory exporter 验证导出条目结构正确）。
3. 未注入 `Telemetry` 时 Runner 行为与现状完全一致；`check-core-zero-deps` 通过、core lint 纯度不破（埋点全在 Runner / adapter）。

<!-- Backfill after execution:
**Reviewed**: <date> by reviewer
**Commit**: <hash> <subject>
-->

---

### Phase 2: 成本 / 延迟 / token 指标导出

**Goal**: Runner 经 `Telemetry.metric` 导出 per-turn / per-tool / per-model 的延迟 ms、token 计数、成本$（成本 = 归一化 usage × 单价表），归因属性齐全，不破纯度。

**Files covered**:
- `packages/runtimes/node/src/runner.ts`（span 关闭时记录延迟、token、成本 metric）
- `packages/sdk/src/create-agent.ts`（单价表 `pricing` 配置透传）
- `packages/telemetry-otel/`（metric 导出实现）
- 对应 `__tests__/`

**Tasks**:
- [ ] 延迟：用注入 `Clock`（或 adapter 时钟）测 turn / model / tool span 起止差，关闭时 `metric("latency_ms", dur, attrs)`
- [ ] token：从归一化 usage 取 input/output token，`metric("tokens", n, { kind, model, turnId })`
- [ ] 成本：SDK 透传"模型单价表"（输入/输出分别计价），Runner 用 usage × 单价计算 `metric("cost_usd", v, attrs)`；未配置单价时跳过成本但仍导延迟/token
- [ ] 归因 attrs 统一：`turnId` / `toolName` / `model`，turn 级聚合可由 collector 侧汇总
- [ ] 测试:mock Telemetry 断言一轮 metric 条目齐全且数值正确（含成本计算）；无单价表时不报错、只缺成本

**Acceptance Criteria**:
1. 每 turn / 工具 / 模型调用导出延迟 ms、token 计数指标，归因属性（turnId / toolName / model）正确。
2. 配置单价表时导出成本$，数值 = usage × 单价；未配置时跳过成本、其余指标不受影响。
3. 指标导出全在 Runner / adapter，核心无新增时间/成本事实；纯度不破。

<!-- Backfill -->

---

### Phase 3: 审计日志（审批决策 + 高风险工具执行）

**Goal**: 所有审批决策与高风险工具执行（`WRITE_HIGH` / `IRREVERSIBLE`）落结构化审计条目，经专用 sink / Telemetry 旁路导出，不改主循环控制流、不抛异常。

**Files covered**:
- `packages/runtimes/node/src/runner.ts`（在 `approval_decision` 解释处 + 高风险工具执行处构造审计条目）
- `packages/sdk/src/create-agent.ts`（可选注入 `auditSink`，缺省 no-op）
- `packages/sdk/src/audit.ts`（新增：审计条目类型 + 默认 sink）
- 对应 `__tests__/`

**Tasks**:
- [ ] 定义审计条目结构（`kind: "approval" | "high_risk_exec"`、toolName、riskTier、decision?、timestamp、isError?、归因 id）
- [ ] Runner：`interpretEffects` 处理 `approval_decision`（runner.ts:434）时记审批审计条目（allow/deny + 工具）
- [ ] Runner：执行工具前/后，对 `toolDef.riskTier ∈ {WRITE_HIGH, IRREVERSIBLE}` 记高风险执行审计条目（含结果 isError）
- [ ] SDK：可选 `auditSink`（缺省 no-op），可桥接到 `Telemetry`；条目时间戳用注入 `Clock`
- [ ] 测试:审批 allow/deny 各产一条审计；高风险工具执行产一条；只读工具/低风险不产；错误执行仍记录且不抛

**Acceptance Criteria**:
1. 每个审批决策（allow / deny）产生一条结构化审计条目，含工具名与决策。
2. 每次高风险工具（`WRITE_HIGH` / `IRREVERSIBLE`）执行产生一条审计条目，含 riskTier 与执行结果；只读/低风险不产生。
3. 审计旁路主循环：不改 reducer、不改控制流、错误不中断循环；未注入 auditSink 时行为不变。

<!-- Backfill -->

---

### Phase 4: 时间旅行调试器（checkpoint 历史 + 回退 / 单步 / diff）

**Goal**: 在不改 `SessionStore` 端口的前提下新增追加式每-turn checkpoint 历史；调试器可列出某 session 全部 checkpoints、回退到任一、用核心 `step` 单步重放、与任一后续状态结构化 diff。

**Files covered**:
- `packages/core/src/state-diff.ts`（新增纯函数 `diffState(a, b)`）
- `packages/core/src/index.ts`（导出 `diffState` + 类型）
- `packages/runtimes/node/src/runner.ts`（turn 边界追加 checkpoint 历史，key = `sessionId#seq`）
- `packages/sdk/src/debugger/index.ts`（新增：`listCheckpoints` / `rewindTo` / `stepForward` / `diff`）
- `apps/reference-cli`（CLI 文本交互：列出/回退/单步/diff）
- 对应 `__tests__/`（含重放等价断言）

**Tasks**:
- [ ] core 纯函数 `diffState(a, b)`：产出结构化差异（messages 增删、status 变迁、pendingTools、tokensUsed/iterationCount、readFiles 等），纯、可序列化、可测
- [ ] Runner：每 turn 边界向历史存储追加带递增 `seq` 的 checkpoint（复用 `SessionStore` 多 key：`${sessionId}#${seq}`，不覆盖既有单 key 行为；或薄 `CheckpointHistory` 包装）
- [ ] 调试器 API:`listCheckpoints(sessionId)`（按 seq 排序）、`rewindTo(sessionId, seq)`（取该快照）、`stepForward(state, input, ctx)`（调核心 `step`，不触真实 port）、`diff(a, b)`（调 `diffState`）
- [ ] reference-cli：增调试子命令（列出 turn checkpoints、回退到指定 turn、单步前进、与原始后续状态 diff 并打印）
- [ ] 测试:录一段多 turn 会话 → 列出 N 个 checkpoints → 回退到第 k 个 → 从该状态 `step` 单步重放，断言与原始 (state, effects) 序列 deep-equal（重放等价）；`diffState` 单测覆盖各字段差异；checkpoint 历史不破坏现有 `SessionStore` 合同测试

**Acceptance Criteria**:
1. 一段多 turn 会话产生可列举的 checkpoint 历史，可回退到任一 turn 的快照。
2. 从任一 checkpoint 用核心 `step` 单步重放，结果与原始运行 (state, effects) 序列 deep-equal（吃可重放红利）。
3. `diffState(a, b)` 产出结构化、可读的状态差异；调试器经 reference-cli 可"回退某 turn → 单步 → 看 diff"。
4. checkpoint 历史以附加方式实现，既有 `SessionStore` 合同测试零回归。

<!-- Backfill -->

---

### Phase 5: 多 agent 编排拓扑（supervisor + pipeline，声明式可组合）

**Goal**: 提供声明式拓扑规格 + SDK 编排器，落地 supervisor + pipeline 两种拓扑，可声明式组合；子 agent 隔离复用既有机制，结果可聚合；拓扑确定性纯决策可重放。

**Files covered**:
- `packages/core/src/orchestration.ts`（新增：拓扑 spec 类型 + 确定性纯决策——pipeline 串接顺序、聚合归并顺序、router 匹配）
- `packages/core/src/index.ts`（导出拓扑 spec 类型 + 纯决策函数）
- `packages/sdk/src/orchestration/index.ts`（新增：编排器，把 spec 实例化为子 agent 协作，复用 `createSubAgentExecutor`）
- `packages/sdk/src/create-agent.ts`（暴露 `createOrchestrator(spec)` / 或经 options 声明拓扑）
- 对应 `__tests__/`

**Tasks**:
- [ ] core:定义拓扑 spec 纯数据类型（节点 = 子 agent 定义 prompt/tools/model/policy；边 = 数据流 + 聚合方式；kind ∈ supervisor/pipeline，预留 map-reduce/debate/router 枚举）
- [ ] core:确定性纯决策——pipeline 的串接顺序、map-reduce 的聚合归并顺序、router 的路由匹配（纯函数，可重放）；supervisor 的"模型裁决分派"本质是一次子 agent 调用，不在核心写非确定逻辑
- [ ] SDK 编排器:解释 spec → 为每节点经 `createSubAgentExecutor` 起隔离子 agent → pipeline 串接 / supervisor 分派+汇聚；并行分派吃 M8 并行能力；结果聚合回主流程作为文本/工具结果
- [ ] SDK:暴露 `createOrchestrator(spec)`（或 createAgent options）；子 agent 隔离、共享 ModelPort、事件经 `tagEventSink` 标 depth
- [ ] 测试:pipeline——三节点串接，前节点输出进后节点，最终聚合正确；supervisor——主管分派给 ≥2 worker、结果汇聚；子 agent 上下文隔离（worker 看不到彼此/父历史）；确定性归并的重放等价（同 mock 脚本两次运行 deep-equal）

**Acceptance Criteria**:
1. supervisor + pipeline 两种拓扑均可经声明式 spec 组合并运行。
2. 子 agent 上下文隔离（复用既有机制，worker 间 / 与父互不可见上下文），结果可聚合回主流程。
3. 拓扑的确定性归并/串接为纯决策、可重放：同一 mock 脚本两次运行 (state, effects) deep-equal。
4. 编排建立在 M8 引擎（并行/调速）与既有子 agent 之上，未重做引擎、未重定义端口。

<!-- Backfill -->

---

## 6. Risks and mitigations

| Risk | Impact | Mitigation |
|---|---|---|
| 遥测埋点诱使引入时间/IO 进核心 | 破坏纯度 / 可重放 | span/指标/审计全部落 Runner / adapter；`Telemetry` 经端口注入；`check-core-zero-deps` + core lint 把关；未注入时行为不变 |
| 误改 M8 `Telemetry` 端口类型 | 与 Plan 002 冲突、后续返工 | 本 Plan 只实现 adapter / 消费，端口签名只读；review 时对照 §4.7 边界表 |
| 时间旅行与 M11 eval 职责重叠 | 重复造轮、归属混乱 | §4.4 明确：调试器=交互回放、eval=自动断言；本 Plan 不做断言/回归框架，仅消费公共轨迹格式 |
| checkpoint 历史改坏 `SessionStore` 合同 | store 测试回归 | 不改端口；用多 key（`sessionId#seq`）追加，既有单 key 行为不变；保留 `SessionStore` 合同测试为回归门 |
| checkpoint 历史无界增长 | 存储膨胀 | 仅在 turn 边界追加；提供保留条数/裁剪配置；调试场景按需开启 |
| 编排拓扑写入非确定逻辑进核心 | 破坏可重放 | 核心只放确定性归并/路由/串接；"模型裁决分派"走子 agent 调用，不入核心；重放测试覆盖确定性归并 |
| 编排重做引擎 / 重写隔离 | 与 M8 / M7 重叠 | 拓扑建立在 M8 并行 + 既有 `createSubAgentExecutor` 之上；不复制引擎、不重写隔离 |
| 成本单价表口径不一 | 成本指标失真 | 单价表为显式配置（输入/输出分价），未配置则不导成本只导延迟/token；口径在文档明确 |
| 审计条目影响主循环 | 控制流被污染、可能抛异常中断 | 审计旁路:不进 reducer、不改控制流、错误不抛；缺省 no-op sink |
