# Plan 002 — M8 内核编排引擎深化 + 端口面扩展

> **Status**: Complete
> **Owner**: TBD
> **Created**: 2026-06-09
> **Depends on**: 演进路线图 [docs/roadmap.md](../docs/roadmap.md) M8；架构设计 [docs/pure-volto.md](../docs/pure-volto.md)；Plan 001（M1–M7 已交付）
> **Target area**: `packages/core/src/{state,input,effect,reducer,ports,index}.ts`、`packages/runtimes/node/src/runner.ts`、`packages/sdk/src/{create-agent,defaults}.ts`

## 1. 背景

### 1.1 问题陈述

M1–M7 交付的内核能跑通"对话 → 工具 → 结果回喂 → 最终回复"的单线性 inner-loop，但核心编排引擎仍停留在最小形态，且端口面只覆盖基础 I/O。要把内核做成 [roadmap](../docs/roadmap.md) 所述的"平台"，M8 须深化**内核编排引擎**（WS-1）并扩展**端口契约面**（WS-2），且全程不破坏纯度 / 可重放这一立身之本。

本 Plan 落地 M8 的两组能力：

- **WS-1 引擎**：并行工具执行 + 确定性结果归并、steering（turn 进行中插话）、资源调速器、循环/震荡检测。
- **WS-2 端口**：新增 9 个端口接口（纯类型契约）+ SDK 侧 no-op/内存兜底，为 M9–M14 的能力解锁预留扩展点而不返工核心。

### 1.2 现状审计

| 维度 | 当前实现 | 目标状态 |
|---|---|---|
| 工具执行 | Runner 对 `state.pendingTools` **逐个串行 `await`**；reducer 收到 `tool_result` 即按到达顺序 append 消息 | Runner 并行执行；reducer 按 `pendingTools` 规范顺序**缓冲归并**，重放仍 deep-equal |
| 中途插话 | `executing_tools` / `calling_model` 收到 `user_message` **直接抛错**（reducer line 432） | 入队，turn 边界注入，不打断进行中的工具 |
| 资源治理 | `limitReached` 仅管 `tokenBudget` + `maxIterations` | 核心增管"工具调用数"确定性维度；Runner 增管 wallclock / 成本$，越限归一为终止 input |
| 循环检测 | 无 | 连续 K 次相同失败工具调用 → 干预，纯函数可重放 |
| 端口面 | 11 个基础端口（Model/FileSystem/Shell/Network/SessionStore/EventSink/ApprovalGate/Clock/Id/Random/Tokenizer） | +9 个契约：ToolSource / MemoryStore / Embedder / Telemetry / Cache / Sandbox / Secrets / Scheduler / PolicyEngine（纯类型 + SDK 兜底） |

### 1.3 设计目标

1. **并发不破坏可重放**：并行执行工具，但同一串 input 两次运行的 (state, effects) 序列仍完全一致。
2. **核心保持纯**：新端口仅类型；wallclock / 成本等时间相关治理留在 Runner，核心只裁决确定性维度。
3. **契约先行**：端口以最小接口落地 + SDK no-op/内存兜底，真实 adapter 留给后续里程碑，不在 M8 膨胀实现。
4. **向后兼容**：现有 SDK 最小配置（仅 model）与既有测试零回归。
5. **错误不中断循环**：所有新增终止路径（预算 / 循环）一律归一为状态转移 + 明确 reason，绝不抛异常。

## 2. Goals

1. 核心新增 9 个端口接口（纯类型），`@volto/core` 仍零运行时依赖；SDK 提供 no-op/内存兜底默认实现。
2. 资源调速器：核心强制 token 预算 + 工具调用数 + 最大迭代数（确定性）；Runner 监控 wallclock + 成本$ 并在越限时回喂归一化终止 input。
3. 并行工具执行：Runner 并行跑同一轮的多个 tool_use（HITL `ask` 工具仍正确串行化），reducer 按 `pendingTools` 规范顺序归并结果，重放等价。
4. steering：turn 进行中的 `user_message` 入队，在 turn 边界注入，不打断进行中的工具；可重放。
5. 循环/震荡检测：连续 K 次相同失败工具调用触发干预（纯决策）。
6. 全程满足验收 + `pnpm turbo run typecheck lint test` 通过 + `check-core-zero-deps` 通过 + 既有重放测试不回归。

## 3. Non-Goals

1. **不**实现 9 个新端口的真实 adapter（如真实 Telemetry/OTel、真实向量 MemoryStore、容器沙箱）——仅类型契约 + 兜底，真实实现归 M9–M14。
2. **不**实现 RAG / 分层记忆 / 缓存命中等消费这些端口的上层逻辑（归 M9+）。
3. **不**实现多 agent 编排拓扑（supervisor/pipeline 等，归 M12）。
4. **不**改变现有工具包、provider、store 的对外行为。
5. **不**引入 `Date.now()` / 随机 等隐式副作用进核心（wallclock 经 Runner 处理）。

## 4. Key decisions

### 4.1 steering 语义：队列 + turn 边界注入

**决策**：turn 进行中（`calling_model` / `executing_tools`）收到的 `user_message` 入队到状态字段 `queuedUserInputs`，**不打断**进行中的 model stream 与工具；在 turn 边界（所有工具完成、即将转 `calling_model` 或 turn 收束处）把队列消息注入 `messages` 再继续。

**理由**：最可预测、最易保证可重放（注入点确定）；不浪费进行中的工具工作。相比"中止并重启 turn"省去复杂取消链路与算力浪费。中止式 steering 留作后续可选扩展。

### 4.2 端口深度：纯类型契约 + SDK no-op/内存兜底

**决策**：M8 只为 9 个端口落**纯类型接口**（核心零依赖不破），并在 SDK `defaults.ts` 提供 no-op（Telemetry/Scheduler）、内存（Cache/MemoryStore）、allow-all（PolicyEngine）等兜底实现，保证可注入、可测、最小配置仍可启动。

**理由**：契约先行符合 roadmap M8 "纯类型零实现"定调；兜底让端口"可缺席"且不阻断启动；真实 adapter 与上层消费逻辑随对应里程碑落地，避免 M8 范围膨胀。

### 4.3 资源调速器：核心管确定性维度，Runner 管时间/成本

**决策**：reducer 在 `limitReached` 基础上增管**工具调用数**（确定性，纯函数可裁决）；**wallclock 与成本$** 由 Runner 监控（成本来自归一化 usage），越限时 Runner 回喂一个归一化的终止 input（复用/扩展 `cancel`，reason 标注 `budget_exceeded`），由核心统一转 `done`。

**理由**：纯 reducer 读不到 wall-clock，强行经 input 注入时间会让每步都背时间事实、接口变重且易错；把时间/成本治理留在 Runner、核心只裁决确定性维度，既守纯度又完整。

### 4.4 并行执行 + 确定性归并

**决策**：Runner 先对本轮 `pendingTools` 做权限分流——`allow` 工具并行执行（有界并发），`ask` 工具串行经审批闭环；reducer 收到乱序到达的 `tool_result` 时**按 `pendingTools` 原始顺序缓冲归并**后再 append 消息，保证消息序列与到达顺序无关。

**理由**：并行提速的同时，归并顺序的确定性是可重放的前提。权限分流确保 HITL 语义不被并发破坏。

### 4.5 端口接口清单（最小契约）

新增于 `packages/core/src/ports.ts`（仅类型）：

| 端口 | 最小方法（签名示意） | 职责 |
|---|---|---|
| `ToolSource` | `list(): Promise<ToolDefinition[]>`；可选 `onChange(cb)` | 动态工具源（为 MCP / 插件预留） |
| `MemoryStore` | `save(entry)` / `query(text, k)` / `delete(id)` | 语义/长期记忆存取 |
| `Embedder` | `embed(texts): Promise<number[][]>` | 文本 → 向量 |
| `Telemetry` | `startSpan(name, attrs)` / `metric(name, value, attrs?)` | 结构化遥测（区别于面向用户的 EventSink） |
| `Cache` | `get(key)` / `set(key, value, ttl?)` / `delete(key)` | 通用缓存（为 prompt/response 缓存预留） |
| `Sandbox` | `run(spec): AsyncIterable<ExecEvent>`（含隔离策略字段） | 受隔离的执行环境（Shell 的泛化） |
| `Secrets` | `resolve(ref): Promise<string \| undefined>` | 凭据安全解析 |
| `Scheduler` | `schedule(whenMs, ref)` / `cancel(id)` / `sleep(ms)` | 定时/延迟/后台任务 |
| `PolicyEngine` | `evaluate(request): Promise<"allow" \| "deny" \| "ask">` | 外置授权决策（PermissionPolicy 的可插拔延伸） |

## 5. 实现计划

> Phase 1（端口契约）低风险打底，最先做；Phase 2（并行执行）是最大的核心改造，作为 Phase 3–5 的引擎基础；Phase 3 steering、Phase 4 调速器、Phase 5 循环检测依次叠加。严格串行、逐 Phase review + 单独 commit。

### Phase 1: 端口面扩展（纯类型契约 + SDK 兜底）

**Goal**: 核心新增 9 个端口接口（仅类型），SDK 提供 no-op/内存兜底默认实现，核心仍零依赖、最小配置仍可启动。

**Files covered**:
- `packages/core/src/ports.ts`（新增 9 个接口 + `ModelEventUsage` 预置可选 `cacheReadTokens?` / `cacheWriteTokens?`）
- `packages/core/src/index.ts`（导出新端口类型）
- `packages/sdk/src/defaults.ts`（no-op/内存兜底）
- `packages/sdk/src/create-agent.ts`（可选注入这些端口）
- 对应 `__tests__/`

**Tasks**:
- [x] 在 `ports.ts` 新增 `ToolSource` / `MemoryStore` / `Embedder` / `Telemetry` / `Cache` / `Sandbox` / `Secrets` / `Scheduler` / `PolicyEngine` 接口（纯类型，含相关结果/参数类型）
- [x] `ModelEventUsage` 预置可选字段 `cacheReadTokens?` / `cacheWriteTokens?`（为 M9 Prompt 缓存计量预留；ports.ts 单一归属于 M8，下游 provider 仅填充不改类型）
- [x] `index.ts` 统一导出新端口类型
- [x] SDK `defaults.ts` 提供兜底：no-op `Telemetry`、no-op `Scheduler`、内存 `Cache`、内存 `MemoryStore`、allow-all `PolicyEngine`、缺省 `Secrets`（返回 undefined）、空 `ToolSource`
- [x] `createAgent` 接受可选注入这些端口（缺省走兜底）
- [x] 测试：兜底实现 smoke（各方法可调用、语义正确）；最小配置（仅 model）仍可启动

**Acceptance Criteria**:
1. `@volto/core` 仍零运行时依赖（`check-core-zero-deps` 通过），新端口均为纯类型（core lint 纯度规则不破）。
2. SDK 最小配置（仅 `modelPort`）可启动并完成一轮对话（既有用例不回归）。
3. 9 个兜底实现各有 smoke 测试且通过。

<!-- Backfill after execution:
**Reviewed**: <date> by reviewer
**Commit**: <hash> <subject>
-->
**Reviewed**: 2026-06-09 by reviewer
**Commit**: 0595603 feat(plan-002): phase 1 - 端口面扩展（纯类型契约 + SDK 兜底）

---

### Phase 2: 并行工具执行 + 确定性结果归并

**Goal**: Runner 并行执行本轮多个 `allow` 工具（`ask` 工具仍串行经审批），reducer 按 `pendingTools` 规范顺序缓冲归并结果，重放等价。

**Files covered**:
- `packages/core/src/state.ts`（结果缓冲字段，如 `toolResultBuffer`）
- `packages/core/src/reducer.ts`（`handleExecutingTools` 归并逻辑）
- `packages/runtimes/node/src/runner.ts`（并行派发 + 权限分流）
- 对应 `__tests__/`（含重放测试扩展）

**Tasks**:
- [x] reducer：`executing_tools` 收到 `tool_result` 时写入按 id 索引的缓冲，仅当全部 `pendingTools` 完成后按**原始顺序**一次性 append `tool_result` 消息，再转 `calling_model`（保证顺序确定）
- [x] Runner：本轮 `pendingTools` 权限分流——`allow` 工具有界并发执行，`ask` 工具走既有串行审批闭环；保留单工具执行后即时回喂
- [x] Runner：并行执行期间收到 `Cancel` → 中止全部进行中工具、清理 pending、转 `cancelling`
- [x] 重放测试：构造乱序到达的多工具结果，断言两次运行 (state, effects) deep-equal
- [x] 回归：既有单工具 / HITL / resume 测试全绿

**Acceptance Criteria**:
1. 一轮 assistant 含 N 个 tool_use 时，Runner 并行执行 `allow` 工具；最终 `messages` 中 tool_result 顺序严格等于 `pendingTools` 原始顺序，**与完成先后无关**。
2. 重放测试：乱序结果到达，两次运行 (state, effects) 序列 deep-equal。
3. HITL `ask` 工具在并行批中仍正确串行审批；`Cancel` 能中止进行中的并行批并清理 pending。

<!-- Backfill -->
**Reviewed**: 2026-06-09 by reviewer
**Commit**: 3ed9675 feat(plan-002): phase 2 - 并行工具执行 + 确定性结果归并

---

### Phase 3: steering（中途插话，队列 + turn 边界注入）

**Goal**: turn 进行中的 `user_message` 入队、turn 边界注入，不打断进行中的工具，可重放。

**Files covered**:
- `packages/core/src/state.ts`（`queuedUserInputs` 字段）
- `packages/core/src/reducer.ts`（`calling_model` / `executing_tools` 接受 `user_message` 入队；turn 边界 drain）
- 对应 `__tests__/`

**Tasks**:
- [x] state 增 `queuedUserInputs: UserMessage[]`（可序列化，survives resume）
- [x] reducer：`calling_model` / `executing_tools` 收到 `user_message` → 入队，不抛错、不打断
- [x] reducer：turn 边界（工具全部完成转 `calling_model` 处、及 turn 收束处）drain 队列注入 `messages`，注入点确定
- [x] 重放测试：相同插话 input 序列两次运行结果一致
- [x] 测试：插话不改变进行中工具的执行与结果

**Acceptance Criteria**:
1. `executing_tools` / `calling_model` 期间注入 `user_message` 被入队（不再抛错），进行中的工具不受影响。
2. 队列消息在下一个 turn 边界被注入 `messages` 并参与后续模型调用。
3. 重放测试：含插话的 input 序列两次运行 (state, effects) deep-equal。

<!-- Backfill -->
**Reviewed**: 2026-06-09 by reviewer
**Commit**: 1eed8ec feat(plan-002): phase 3 - steering（中途插话，队列 + turn 边界注入）

---

### Phase 4: 资源调速器（确定性维度在核心 + Runner 时间/成本）

**Goal**: 核心增管工具调用数（确定性），Runner 增管 wallclock/成本$，越限归一为终止 input。

**Files covered**:
- `packages/core/src/state.ts`（`toolCallCount` + 预算配置字段）
- `packages/core/src/input.ts`（终止 input 的 reason 扩展，如 `budget_exceeded`）
- `packages/core/src/reducer.ts`（`limitReached` 扩展 + 终止路径）
- `packages/runtimes/node/src/runner.ts`（wallclock/成本监控 + 回喂终止 input）
- 对应 `__tests__/`

**Tasks**:
- [x] state/ctx：新增工具调用数计数与上限、成本上限、wallclock 上限配置字段
- [x] reducer：`limitReached` 增管工具调用数；越限时转 `done` 并 emit 明确 reason（不抛异常）
- [x] input：扩展 `cancel`/新增终止 input 的 `reason: "budget_exceeded"`，core 统一转 `done`
- [x] Runner：累计 wallclock 与成本（来自归一化 usage），越限时回喂归一化终止 input
- [x] 测试：token / 工具调用数 / 迭代数 越限 → 核心终止（重放确定）；wallclock / 成本越限 → Runner 回喂终止 → 核心转 done

**Acceptance Criteria**:
1. token / 工具调用数 / 最大迭代数任一越限 → 核心转 `done` 并产出明确终止 reason，**不抛异常**；重放确定。
2. wallclock / 成本$ 越限 → Runner 监测并回喂归一化终止 input，核心统一转 `done`。
3. 未配置上限时行为与现状一致（向后兼容）。

<!-- Backfill -->
**Reviewed**: 2026-06-09 by reviewer
**Commit**: 9034b39 feat(plan-002): phase 4 - 资源调速器（核心确定性维度 + Runner wallclock/成本）

---

### Phase 5: 循环/震荡检测

**Goal**: 连续 K 次相同失败工具调用触发干预，纯决策、可重放。

**Files covered**:
- `packages/core/src/loop-detector.ts`（新增纯函数）
- `packages/core/src/reducer.ts`（在工具边界接入检测）
- `packages/core/src/index.ts`（导出）
- 对应 `__tests__/`

**Tasks**:
- [x] 实现纯函数：扫描近期消息，识别连续 K 次"相同 name + 相同 input + isError" 的工具调用
- [x] reducer：在形成 `pendingTools` / 工具边界处接入检测，命中则注入干预（终止并 emit reason，或回喂系统提示——二选一在实现时定，需可重放）
- [x] 单测：K 次相同失败触发；不同 input / 成功结果 不误判；边界（不足 K 次）
- [x] 重放测试：含震荡序列两次运行一致

**Acceptance Criteria**:
1. 连续 K 次相同失败工具调用触发干预（终止 + reason 或系统提示），可配置 K。
2. 合法重复（input 不同 / 结果非错误）不被误判。
3. 纯函数、无隐式副作用；含震荡序列的重放测试 deep-equal。

<!-- Backfill -->
**Reviewed**: 2026-06-09 by reviewer
**Commit**: 437285f feat(plan-002): phase 5 - 循环/震荡检测（纯函数 + reducer 接入）

---

## 6. Risks and mitigations

| Risk | Impact | Mitigation |
|---|---|---|
| 并行执行破坏可重放 | 回归测试失效、bug 不可复现 | 结果按 `pendingTools` 规范顺序缓冲归并；新增乱序到达的重放测试作回归门 |
| steering 注入点不确定 | 行为不可预测、难重放 | 注入点固定在 turn 边界；入队字段纳入可序列化状态；重放测试覆盖 |
| 端口契约设计不当致后续返工 | M9+ 频繁改核心接口 | 端口取最小方法集 + 可缺席语义；先类型后实现，真实 adapter 时再细化 |
| wallclock 治理诱使引入隐式时间进核心 | 破坏纯度/可重放 | 明确分工：核心只裁决确定性维度，时间/成本在 Runner；core lint 纯度规则把关 |
| 并行 + HITL 交互复杂 | 审批语义错乱 | 权限分流：`allow` 并行、`ask` 串行经既有闭环；复用 `approvedToolCallIds` 防重复审批 |
| 工具调用数计数与 resume 冲突 | 跨进程续跑计数错乱 | 计数纳入可序列化状态，随 checkpoint 持久化 |

---

## 7. Test Cases

### TC-P2-001: 端口接口纯类型 + SDK 兜底可调用

- **Preconditions**: 项目构建通过，core 零依赖
- **Steps**:
  1. 运行 `node scripts/check-core-zero-deps.mjs`
  2. 在 SDK 中 `createAgent({ modelPort })` 并访问 `agent.ports` 的 9 个端口
  3. 对每个兜底调用其核心方法（list/save/query/embed/startSpan/get/schedule/evaluate/resolve）
- **Paths**: `packages/core/src/ports.ts:227-341`, `packages/sdk/src/defaults.ts:70-184`, `packages/sdk/src/__tests__/m8-port-defaults.test.ts`
- **Expected**: 零依赖 PASS；9 个兜底方法可调用且语义正确（no-op 返回 undefined/空、throw 返回明确错误、allow-all 返回 "allow"）

### TC-P2-002: 并行工具执行确定性归并

- **Preconditions**: reducer 支持 `_toolResultBuffer` 缓冲
- **Steps**:
  1. 构造 model_done(tool_use) 带 3 个 tool_use（A, B, C）
  2. 以反序 C→B→A 送入 tool_result
  3. 断言最终 messages 中 tool_result 顺序为 A→B→C
  4. 重放：两次相同乱序输入序列 → final state + effects deep-equal
- **Paths**: `packages/core/src/reducer.ts:368-415`, `packages/core/src/__tests__/reducer-parallel.test.ts:88-140`
- **Expected**: 消息顺序与 pendingTools 原始顺序一致；重放确定

### TC-P2-003: Steering 中途插话入队 + turn 边界注入

- **Preconditions**: state 含 `queuedUserInputs` 字段
- **Steps**:
  1. 将 reducer 驱动至 `calling_model` 状态
  2. 送入 `user_message`（中途插话）
  3. 断言状态仍为 `calling_model`，`queuedUserInputs` 长度 +1，不抛错
  4. 完成工具执行 → 触发 turn 边界 drain
  5. 断言队列消息出现在 messages 中且 `queuedUserInputs` 清空
  6. 重放：相同插话 input 序列两次运行 final state deep-equal
- **Paths**: `packages/core/src/reducer.ts:350-358`（入队）、`packages/core/src/reducer.ts:405-415`（drain）、`packages/core/src/__tests__/steering.test.ts:56-100`
- **Expected**: 插话不打断工具、队列消息在 turn 边界注入、重放确定

### TC-P2-004: 工具调用数越限 → 核心终止

- **Preconditions**: state 含 `toolCallCount`/`maxToolCalls`
- **Steps**:
  1. 设置 `maxToolCalls = 2`
  2. 驱动 2 次完整工具调用循环（每次 model_done(tool_use) 递增 `toolCallCount`）
  3. 第 3 次 model_done(tool_use) 时，`toolCallCount` 越限
  4. 断言 `status === "done"` 且 emit error 事件包含 "Tool call limit exceeded"
- **Paths**: `packages/core/src/reducer.ts:279-296`（计数递增 + limit 检查）、`packages/core/src/__tests__/resource-governor.test.ts:85-110`
- **Expected**: 越限 → 转 done + emit error，不抛异常

### TC-P2-005: budget_exceeded 统一终止

- **Preconditions**: 新增 `BudgetExceededInput`
- **Steps**:
  1. 驱动至 `calling_model` 状态
  2. 送入 `{ type: "budget_exceeded", reason: "Wallclock limit exceeded" }`
  3. 断言 `status === "done"`，emit 事件含 `budget_exceeded` 类型和 reason
  4. 在 `executing_tools` 状态同样测试
- **Paths**: `packages/core/src/reducer.ts:127-140`（统一 handler）、`packages/core/src/__tests__/resource-governor.test.ts:116-160`
- **Expected**: 任何 active 状态收到 budget_exceeded → done + emit budget_exceeded

### TC-P2-006: Runner wallclock/成本监控

- **Preconditions**: Runner 含 `turnStartTime`/`cumulativeCost` 跟踪
- **Steps**:
  1. 配置 `maxWallclockMs: 1`（极小值）
  2. 运行一轮（含模型调用）
  3. 断言 Runner 回喂 `budget_exceeded` input 导致 turn 终止
  4. 配置 `maxCostTokens: 1`（极小值）
  5. 断言 usage 累加后超过限制 → `budget_exceeded`
- **Paths**: `packages/runtimes/node/src/runner.ts:134-155`（tracking）、`packages/runtimes/node/src/runner.ts:357-358`（重置）
- **Expected**: Runner 监测越限 → feed budget_exceeded → 核心转 done

### TC-P2-007: 循环检测 K 次相同失败触发终止

- **Preconditions**: `maxLoopCount` 已配置
- **Steps**:
  1. 构造 2 对 prior (assistant(tool_use)→tool_result(isError))，tool name+input 相同
  2. 新 model_done(tool_use) 发出相同的第 3 个 tool call
  3. 断言 `detectLoop` 返回 `detected: true`
  4. 断言 reducer 转 done + emit error 含 "Loop detected"
- **Paths**: `packages/core/src/loop-detector.ts:41-82`、`packages/core/src/reducer.ts:299-314`、`packages/core/src/__tests__/loop-detector.test.ts:150-200`
- **Expected**: K 次相同失败 → 终止 + reason

### TC-P2-008: 循环检测合法重复不误判

- **Preconditions**: `maxLoopCount = 3`
- **Steps**:
  1. 仅 1 对 prior（不足 K-1）→ 断言不触发
  2. prior 中 input 不同 → 断言不触发
  3. prior 中 tool name 不同 → 断言不触发
  4. prior 中 result 非 error → 断言不触发
- **Paths**: `packages/core/src/__tests__/loop-detector.test.ts:100-135`
- **Expected**: 合法重复（不同 input / 成功结果 / 不足 K 次）不被误判

### TC-P2-009: 全包回归 + 零依赖

- **Preconditions**: 全部 Phase 完成
- **Steps**:
  1. `pnpm turbo run typecheck lint test` → 51 tasks 全通过
  2. `node scripts/check-core-zero-deps.mjs` → PASS
  3. 既有 165+ 核心测试 + 58 runtime 测试 + 46 SDK 测试全绿
- **Paths**: 全局
- **Expected**: 零回归、零新增依赖
