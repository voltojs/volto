# Pure Agent Core 实现梳理与代码审查

> **类型**：代码审查报告（基于 `docs/pure-agent-core.md` v1.0 对照实现）
> **日期**：2026-06-18
> **范围**：`packages/core` / `packages/sdk` / `packages/runtimes/node` 的关键决策与执行路径
> **关联文档**：[架构设计](./pure-agent-core.md)、[演进路线图](./roadmap.md)、[M8–M14 改进计划](./m8-m14-improvement-plan.md)

---

## 0. 一句话结论

**架构骨架忠于设计、纯度铁律守得很严、并行/重放/取消等核心难题处理得相当成熟；最大问题是 §11"缓存命中"承诺涉及的整条 ContextAssembler 链路实际上是死代码、Runner 在自纠路径偷偷 mutate state 破坏了可重放、SDK 用了非确定性 sessionId——这三处直接动摇本内核"立身之本"，建议优先修。其余问题都是工程打磨范畴。**

---

## 1. 实现逻辑梳理

### 1.1 三层结构（与设计文档 §5 对齐）

```
Host (apps/*)                                    ← reference-cli / headless / mcp / ide / ...
  ↓ wiring：选 adapter + 注入能力 + 订阅事件
SDK (packages/sdk · createAgent)                 ← 门面，组装一切
  ↓ run / stream / resume
Runner (packages/runtimes/node · createRunner)   ← 薄解释器（imperative shell）
  ↓ step(state, input, ctx) → { state, effects[] }
Functional Core (packages/core)                  ← 纯函数内核，零依赖
  ↑ 仅依赖接口
Ports (packages/core/src/ports.ts)               ← 19 个接口（ModelPort / FileSystem / Shell / ...）
```

### 1.2 内核核心（packages/core）

- **状态机**：7 状态 `idle → calling_model → executing_tools ⇄ waiting_for_approval → done`，外加 `waiting_for_input` / `cancelling`。
- **Reducer**：`step(state, input, ctx) → { state, effects[] }`（reducer.ts），按 status 路由到子 handler，所有分支返回新对象（不可变更新）。
- **输入**：9 种 `AgentInput`（user_message / model_chunk / model_done / model_error / tool_result / approval_decision / request_approval / cancel / budget_exceeded）。
- **效果**：7 种 `Effect`（call_model / execute_tool / request_approval / emit / checkpoint / wait_for_input / done）——其中 `execute_tool` 与 `wait_for_input` **目前未被 reducer 实际 emit**（见 §3 问题 3）。
- **纯决策模块**：ContextAssembler、Compactor、ToolRouter、PermissionPolicy、LoopDetector、FileGate、Guardrails、SelfCorrect、ErrorTaxonomy、Instructions、Retrieval、StateDiff。
- **Ports**：纯类型，包括基础 6 个（ModelPort / FileSystem / Shell / Network / SessionStore / EventSink）+ HITL 1 个（ApprovalGate）+ 决定性 4 个（Clock / Id / Random / Tokenizer）+ M8 新增 8 个（ToolSource / MemoryStore / Embedder / Telemetry / Cache / Sandbox / Secrets / Scheduler / PolicyEngine）。

### 1.3 执行层（packages/runtimes/node · runner.ts）

主循环 `runLoop()`：

```
while (true)
  budget 检查（wallclock / cost）
  cancellation 短路
  if status = calling_model:
     applyCompaction()                           ← 长上下文压缩（实际触发摘要 model 调用）
     if rag: 注入检索片段                        ← 在 system 之后插入
     stream model events → feed reducer
     执行重试 / 指数退避 / 熔断
  if status = executing_tools:
     按 PermissionPolicy 划分 parallelBatch / approvalQueue
     合并外部 PolicyEngine 决策（最严格优先，fail-closed）
     approvalQueue: 串行通过 HITL
     parallelBatch: Promise.all 并发执行
     按 pendingTools 顺序 feed 每个 tool_result      ← 决定性归并
     untrusted 注入防御 + audit 记录 + self-correct
  if status = cancelling/done/waiting_*: break
```

### 1.4 SDK 装配（packages/sdk · create-agent.ts）

- 输入 adapter（fs/shell/network/lsp/browser/db/document/scheduler）→ 自动注入对应能力 + 自动注册对应工具。
- 工具来源汇合：`opts.tools` + 插件 + 适配器自动工具 + 动态 ToolSource（含 MCP）+ 内置 `ask_user` + 可选 `task` 子 agent。
- 应用 scope/limit 裁剪（默认 ≤20）→ 写入 `stepContext.tools`。
- 包装 EventSink：拦截 usage 用于 cost metering、按策略过滤 reasoning。
- 多轮 turn：`lastFinalState + resetTurnForNextInput()` 续接，保留 messages 与 readFiles。
- Resume 双路径：先尝试同进程 runner.resume，失败再走 SessionStore 加载新建 runner。

### 1.5 三层正交防御（设计文档 §11.1）

1. **能力门控** ToolRouter（core 纯函数）：缺能力 → 工具不可见。
2. **权限策略** PermissionPolicy（core 纯函数）：allow / deny / ask；可叠加 PolicyEngine 取最严格。
3. **沙箱隔离** SandboxedShell（runtime-node）：macOS Seatbelt / Linux bubblewrap + egress proxy。

### 1.6 纯度验证

- `packages/core/package.json` 的 `dependencies / peerDependencies / devDependencies` **三段全空**。
- `grep -rn "Date.now\|Math.random\|crypto.randomUUID\|node:" packages/core/src/`（排除 `__tests__/` 与 `testing/`）**0 处命中**。
- 决定性 port 已建：`Clock` / `Id` / `Random` / `Tokenizer` 接口齐备且核心内确实使用。

---

## 2. 值得肯定的实现要点

| 维度 | 落地点 | 说明 |
|---|---|---|
| **确定性并发归并** | `reducer.ts:436-456` | tool result 按 id 入 buffer，全部 ready 后按 `pendingTools` 顺序 flush，独立于 `Promise.all` 完成顺序 |
| **steering turn-边界注入** | `reducer.ts:407, 462, 526, 589` | mid-turn user_message 入队，仅在 turn 边界 drain，不打断 model stream |
| **runaway guard 双重检查** | `reducer.ts:286, 293` | tool_use 路径用累加 `toolCallCount` 二次检查，避免单 turn 工具数越界漏判 |
| **PolicyEngine fail-closed** | `runner.ts:683-687` | 外部策略引擎抛错 → 回落 `deny` |
| **Cancel 短路** | `runner.ts:413-416, 631-634` | abort 后避免发起新一次 model 调用 |
| **Checkpoint 先于 approval** | `runner.ts:832-849` | 持久化先于审批交互，gate 崩溃也不丢断点 |
| **Resume 双路径** | `create-agent.ts:895-942` | 同进程 runner.resume 失败 → SessionStore 重建 |
| **核心零依赖** | `package.json` | `check-core-zero-deps` 规则真实生效 |
| **核心无隐式副作用** | core 全包扫描 | Date.now/Math.random/node:* 0 处 |

---

## 3. 问题清单（按严重度排序）

### 🔴 P0 — 严重：动摇内核立身之本

#### P0-1：Runner 直接 mutate reducer state（违反设计文档 §4.1 铁律）

**位置**：`packages/runtimes/node/src/runner.ts:781, 786`

```ts
state.selfCorrectionCount++;
state.messages.push({ role: "user", content: decision.repairPrompt });
```

**性质**：imperative shell 在 self-correct 路径绕过 reducer 直接修改核心状态。

**影响**：
- 重放时这条 user 消息**不会**被 reducer 重新生成（它从未经过 step）；
- 任何观察 state 转移的 hook / telemetry 看不到这次变更；
- 直接破坏文档承诺的"同一串 input 必产生同一串 (state, effects)"。

**建议修复**：
- 新增 `ValidationFailedInput` 类型，或复用 `user_message` input；
- 改为 `feed({ type: "user_message", content: decision.repairPrompt })`；
- 让 reducer 内部 bump `selfCorrectionCount`。

---

#### P0-2：ContextAssembler / cacheBreakpoints 整条链路是死代码

**位置**：
- 定义：`packages/core/src/context-assembler.ts`（assembleContext / buildToolPrompt / computeStaticPrefixTokens）
- reducer emit `call_model` 处：`reducer.ts:191, 348, 481, 605` —— 全部直接传 `state.messages`，**无一处调用 `assembleContext`**
- runner.ts 也未调用；RAG 注入用的是自己单独算的 insertIndex（`runner.ts:378-383`）
- `cacheBreakpoints` 只有用户**手动**通过 `RunnerOptions.cacheBreakpoints` 传入才会被 ModelPort 识别

**影响**：
- 设计文档 §11 "缓存命中"一节"ContextAssembler 把静态内容前置 / 工具集变更尽量发生在 turn 边界"的承诺**未落地**；
- 当前只是消息原始顺序碰巧符合常规排序（system 在前）才让 Anthropic / OpenAI 的 prompt cache 命中；
- pinning 字段 `pinnedMessageIds` 同样进了 state 但未在主路径生效。

**建议修复**：
- 在 reducer 构造 `call_model` effect 之前调用 `assembleContext`；
- 把返回的 `messages` 与 `cacheBreakpoints` 一并放入 effect.request；
- 或：迁到 Runner 的 `runModelStream` 中统一处理。

---

#### P0-3：SDK 用 `Date.now() + Math.random()` 拼 sessionId，破坏决定性

**位置**：`packages/sdk/src/create-agent.ts:787, 1054`

```ts
sessionId: `session-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
```

**性质**：SDK 创建 sessionId 没有走注入的 `Clock` / `Random` / `Id` port。

**影响**：相同输入序列两次运行 sessionId 不同，事件流里所有 `sessionId` 字段非确定性，破坏 audit / telemetry 的可重放等价性。

**建议修复**：
- `CreateAgentOptions` 增加可选 `id?: Id` 字段；
- 缺省时 fallback 到当前实现，提供 deterministic ID 时强制走 port。

---

### 🟡 P1 — 重要：架构耦合或语义不一致

#### P1-4：未实现的 Effect 类型与文档示意不一致

**位置**：`packages/core/src/effect.ts:23, 51`

- `ExecuteToolEffect`：reducer 从未 emit；工具执行实际由 Runner 直接读 `state.pendingTools` 派工（`runner.ts:652`）。
- `WaitForInputEffect`：reducer 从未 emit。

**影响**：与设计文档 §5.3 "ExecuteTool → ToolRouter.run(call)" 不一致，code/doc drift。

**建议修复**（择一）：
- **方案 A（推荐）**：让 reducer 在 `executing_tools` 进入时 emit `execute_tool[]`，Runner 解释执行；删除 `WaitForInputEffect`；
- **方案 B**：删除 `ExecuteToolEffect` / `WaitForInputEffect` 死类型，更新文档 §5.3 为"工具调度由 Runner 直读 pendingTools"。

---

#### P1-5：untrusted 防御依赖工具名前缀硬编码

**位置**：`packages/runtimes/node/src/runner.ts:745`

```ts
const isExternal = toolCall.name.startsWith("web_") || toolCall.name.startsWith("mcp__");
```

**影响**：
- 用户自定义不可信工具（`slack_read` / `email_fetch`）**漏判**；
- 名字以 `web_` 开头的可信工具会被错误标记。

**建议修复**：在 `ToolDefinition` 增加声明字段：

```ts
interface ToolDefinition {
  // ...
  /** Output trust level — untrusted output is annotated for prompt-injection defense */
  trust?: "trusted" | "untrusted";
}
```

Runner 改读 `toolDef.trust === "untrusted"`。

---

#### P1-6：Compactor 路径正则会误报，让关键消息无法被压缩

**位置**：`packages/core/src/compactor.ts:75`（`extractFilePaths`）

正则 `(?:\/|\.\.?\/|~\/)[\w./-]+` 会把代码块里的 `import "./foo"`、shell 中的 `/dev/null`、URL 路径片段都误判为文件路径。`isKeyMessage` 据此判断"绝对豁免压缩"，长会话里大量历史消息因此永久豁免。

**影响**：长上下文场景里 Compactor 有效压缩面被压窄甚至无法触发收缩。

**建议修复**：
- 改用来自 `read_file/write_file` 工具 `displayMetadata.path` 的精确信号；
- 把 `isKeyMessage` 从"绝对豁免"降为"优先级低"，必要时仍可压缩。

---

### 🟢 P2 — 建议：可改进但非阻塞

#### P2-7：self-correct 注入消息时序与并行 batch 错位

**位置**：`runner.ts:776-790`

并行 batch 中 self-correct 的 repair 消息**在所有 tool_result feed 完毕之前**就 push 进 messages，导致顺序变成：`tool_result(失败)、user(repair)、tool_result(下一并行结果)`。

**建议**：repair 消息延迟到 batch 全部 feed 完后再注入；或经 reducer 处理（同 P0-1）。

---

#### P2-8：reducer 的 `throw` 在边界条件下打破"绝不抛异常中断主循环"承诺

**位置**：`reducer.ts:165, 206, 412, 495, 531, 624, 634, 644`

未预期 input 类型 / 在 `done` 状态 step 等情形会抛错。`step() called on done state` 在某些重入场景可能被触发。

**建议**：把"非预期 input"转成 emit `internal_error` 事件 + 状态保持不动，给 host 一个可观察渠道。

---

#### P2-9：sub-agent 的 budget / wallclock / cost 与父 agent 完全独立

**位置**：`create-agent.ts:createSubAgentExecutor`

子 agent 创建独立 sessionId / sessionStore，**未透传** `maxCostDollars / maxWallclockMs`，子 agent 成本也未累加到父 agent。

**影响**：单 turn 触发多个 `task` 子 agent 时，主 agent 的 budget 限制完全失效。

**建议**：父 agent 把 budget 上下文（剩余预算）传给子 agent；CostMeter 订阅子 agent EventSink 累加。

---

#### P2-10：`auditSink` 默认是 no-op，缺生产级开箱实现

**位置**：`create-agent.ts:791`

```ts
auditSink: opts.auditSink ?? defaultAuditSink,  // defaultAuditSink 丢弃所有条目
```

**建议**：在 `runtimes/node` 提供 `createFileAuditSink(path)` / `createJsonlAuditSink(stream)` 等开箱即用实现。

---

#### P2-11：`maxCostTokens` 字段命名误导

**位置**：`create-agent.ts:201, 815`

opts 字段叫 `maxCostTokens`，但赋值给 `state.maxCostDollars`，runner 在没配 pricing 时把 token 数直接当 dollar 累加（`runner.ts:430`）。**字段名 ↔ 实际语义**与**有无 pricing**双重切换，极易配置错误。

**建议**：拆分为 `maxTokensPerTurn`（按 token）与 `maxDollarsPerTurn`（必须搭配 pricing）两个清晰字段。

---

#### P2-12：与 P0-2 同源——多个"实现但未接线"的纯函数

| 模块 | 状态 |
|---|---|
| `assembleContext` | 主路径未调用 |
| `buildToolPrompt` | 主路径未调用 |
| `computeStaticPrefixTokens` | 仅诊断用，主路径未调用 |
| `pinnedMessageIds` | state 字段存在，但 reducer / runner 都没用 |

**建议**：要么真接线（推荐，与 P0-2 一并修），要么标记 `@internal` / 暂时移除以减少误导。

---

## 4. 建设性建议（除问题修复外）

### 4.1 把 ContextAssembler 真正接线进 reducer

最小代价改动：reducer 在 emit `call_model` 时调用 `assembleContext + buildToolPrompt`，把结果（含 `cacheBreakpoints`）放进 `effect.request`。这是把整个 §11 缓存命中承诺**从死代码激活成活代码**最直接的一步。

### 4.2 把 `Effect` 当作真单一事实源

当前 Runner 在 `executing_tools` 状态绕过 reducer 直读 `state.pendingTools`。建议要么让 reducer emit `execute_tool[]`（与文档 §5.3 一致），要么明确文档"实际工具调度由 Runner 直读 pendingTools"。两者择一保持心智模型唯一。

### 4.3 增加 reducer-level Replay 等价性测试矩阵

虽然已有 `replay.test.ts`，建议针对组合场景做矩阵测试：**并行工具 × steering × budget_exceeded × cancel × self-correct**。简洁断言：

> 对同一串非时间相关 input，两次运行的 (state without timestamps, effects) 必须 deep-equal。

### 4.4 明确 Reducer/Runner 责任分割文档

代码里 Runner 实际承担了几处"决策"（permission policy 二次评估、self-correct 注入、untrusted 标注），文档却把这些列为 core 决策。建议在 `docs/pure-agent-core.md` §6 加一节"哪些决策在 Runner 上做，为什么"，列清边界。

### 4.5 Budget 模型从"二选一"升为"向量预算"

目前已有 5 维：`maxCostDollars / maxToolCalls / maxWallclockMs / tokenBudget / maxIterations`。建议显式定义 `BudgetSpec` 类型并把检查收拢成纯函数：

```ts
function evaluateBudget(state: AgentState, clock: Clock): BudgetExceededReason | null
```

比现在散在 `reducer.limitReached + runner.checkBudgetLimits` 两处更利于扩展。

### 4.6 给 ToolDefinition 加 `trust` 字段

同 P1-5，把 untrusted 防御从硬编码升级为声明式。

### 4.7 引入"capability ↔ tool"可视化诊断 API

工具门控 + scope 过滤 + permission 三层叠加后，用户调试"为什么我的工具不可见"只能猜。建议 SDK 提供：

```ts
agent.diagnoseTool(name): {
  registered: boolean;
  visibleAfterCapability: boolean;
  visibleAfterScope: boolean;
  permissionDecision: "allow" | "deny" | "ask";
  finalState: "available" | "filtered_by_capability" | "filtered_by_scope" | "denied" | "ask_required";
  missingCapabilities?: string[];
}
```

---

## 5. 修复优先级与推荐顺序

| 优先级 | 问题 | 工作量估算 | 阻塞性 |
|---|---|---|---|
| **P0-1** | Runner mutate state | 2–4h | ✅ 已修 (3ee1729) |
| **P0-2** | ContextAssembler 死代码 | 4–8h | ✅ 已修 (3ee1729) |
| **P0-3** | sessionId 非确定性 | 1–2h | ✅ 已修 (3ee1729) |
| P1-4 | Effect 类型与文档不一致 | 1–6h（视方案） | ✅ 已修 (46808f2) |
| P1-5 | trust 字段化 | 2–3h | ✅ 已修 (46808f2) |
| P1-6 | Compactor 路径正则误报 | 2–4h | ✅ 已修 (46808f2) |
| P2-7 | self-correct 时序 | 与 P0-1 合修 | ✅ 已修 (3ee1729) |
| P2-8 | reducer throw 归一 | 2h | ✅ 已修 (本次) |
| P2-9 | sub-agent budget 透传 | 3–4h | ✅ 已修 (本次) |
| P2-10 | auditSink 生产级实现 | 1–2h | ✅ 已修 (本次) |
| P2-11 | maxCostTokens 命名拆分 | 1h（破坏性） | 待修 |
| P2-12 | 死代码标注/清理 | 与 P0-2 合修 | ✅ 已修 (3ee1729) |

**推荐执行批次**：

1. **批次 A（决定性回归门）**：P0-1 + P0-3 + P2-7。一并解决"非纯/非决定性"违规，配套加 §4.3 测试矩阵。
2. **批次 B（缓存激活）**：P0-2 + P2-12。激活 ContextAssembler 全链路。
3. **批次 C（语义清晰化）**：P1-4 + P1-5 + P2-11。统一心智模型与字段命名。
4. **批次 D（生产打磨）**：P1-6 + P2-8 + P2-9 + P2-10。

---

## 6. 验收标准（用于回归）

每批次完成后必须满足：

1. `pnpm turbo run typecheck lint test` 全绿；
2. `node scripts/check-core-zero-deps.mjs` 通过；
3. 现有 `replay.test.ts` 与 `reducer-parallel.test.ts` 不破；
4. 新增针对该批次问题的回归测试（如 P0-1 配套 self-correct 重放等价测试）；
5. `docs/pure-agent-core.md` 与 `docs/roadmap.md` 中受影响章节同步更新。

---

## 附录 A：审查方法

- 通读 `docs/pure-agent-core.md` v1.0 §1–§15 全部 15 节；
- 抽样阅读 packages/core/src 中 reducer.ts / ports.ts / state.ts / input.ts / effect.ts / context-assembler.ts / compactor.ts / permission-policy.ts / file-gate.ts / loop-detector.ts；
- 抽样阅读 packages/runtimes/node/src/runner.ts 全文（约 1000 行）；
- 抽样阅读 packages/sdk/src/create-agent.ts 全文（约 1070 行）；
- 全仓 grep 验证：核心包零 I/O、SDK / Runner 内 `Date.now / Math.random` 使用情况、`assembleContext` / `cacheBreakpoints` 调用面；
- 验证 `packages/core/package.json` 三段依赖为空。

## 附录 B：未在本次审查范围内的模块

以下模块本次未深入审查，建议后续轮次补充：

- 各 Provider（OpenAI / Anthropic）的流式归一化正确性
- 各 Tool 包（fs / shell / web / code / browser / mcp / ...）的实现细节
- 各 Store（memory / file / sqlite / postgres）的合约一致性测试
- Sandbox（sandbox.ts / sandbox-proxy.ts / egress.ts）的隔离强度
- `packages/eval` 的 replay / simulate / trajectory 实现
- 各 apps（headless-server / mcp-server / ide-extension / github-action / chat-adapter）的 wiring 正确性
