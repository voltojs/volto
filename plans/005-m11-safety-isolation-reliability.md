# Plan 005 — M11 安全、隔离与可靠性 + 调度/后台

> **Status**: Draft
> **Owner**: TBD
> **Created**: 2026-06-09
> **Depends on**: 演进路线图 [docs/roadmap.md](../docs/roadmap.md) M11（WS-6 安全与执行隔离 + WS-7 可靠性与评测 + 横切调度/后台）；架构设计 [docs/pure-agent-core.md](../docs/pure-agent-core.md)；Plan 002（M8 已定义 9 个纯类型端口契约：Sandbox / Secrets / PolicyEngine / Scheduler 等）；Plan 001（M1–M7 已交付）
> **Target area**: `packages/core/src/{permission-policy,reducer,state,input,error-taxonomy,ports,index}.ts`、`packages/runtimes/node/src/{runner,shell,sandbox,scheduler,secrets,policy-engine,guardrails}.ts`、`packages/tools/{shell,web,schedule}`、`packages/sdk/src/{create-agent,defaults}.ts`、`packages/eval/*`（新增 eval harness 包）

## 1. 背景

### 1.1 问题陈述

M1–M7 交付了 PermissionPolicy（allow/deny/ask 三态纯决策）+ HITL 审批闭环 + Runner + 重放测试，M8（Plan 002）规划在 `packages/core/src/ports.ts` 立下 9 个**纯类型端口契约**（含 `Sandbox` / `Secrets` / `PolicyEngine` / `Scheduler`）并由 SDK 提供 no-op/内存兜底。但当前内核的安全面仍停留在"单一全局权限配置 + 直接 child_process 执行 + 无网络/数据脱敏管控"的最小形态：

- **权限只有一套静态配置**：`PermissionConfig`（tier 默认 + 工具名 override）无"模式"概念——无法表达"plan 模式只读、写工具一律不执行""auto-accept 模式自动放行 edits 但 `IRREVERSIBLE` 仍 ask"。M8 立了 `PolicyEngine` 端口类型却无实现。
- **执行无隔离**：`createNodeShell` 直接 `spawn(cmd, { shell: true })`，无文件系统/网络/资源边界；M8 的 `Sandbox` 端口仅有类型，无 adapter。
- **无 guardrails**：来自 web/MCP 的不可信内容直接进上下文，无注入防御标注；工具输出/日志无 PII 脱敏。
- **无 egress 管控、无 secrets 作用域**：Network 端口对任意 URL 放行；M8 的 `Secrets` 端口无实现、无作用域绑定。
- **错误处理无 taxonomy**：reducer 的 `model_error` 仅靠 provider 传入的 `retriable?: boolean` 二分；无瞬时 vs 永久分类、无退避、无熔断；工具错误一律 `isError` 回喂但无重试编排。
- **无自纠回环、无 eval harness、无模拟环境**：内核的纯度/可重放红利尚未兑现为"录制轨迹重放断言 (state, effects) 一致"的 CI 级回归工具。
- **调度/后台缺位**：M8 立了 `Scheduler` 端口类型，但无 adapter、无调度工具，agent 无法表达"延迟动作 / 周期轮询 / 唤醒"。

本 Plan 落地 M11 的三组能力（消费 M8 端口，**绝不重新定义端口类型**）：

- **WS-6 安全与隔离**：权限模式（plan / auto-accept / 规则集，扩展 core PermissionPolicy + 实现 M8 `PolicyEngine`）；沙箱执行 runtime（实现 M8 `Sandbox`，seatbelt/landlock/容器策略）；guardrails（注入防御 / PII 脱敏）；egress 网络管控；secrets 作用域（消费 M8 `Secrets`）。
- **WS-7 可靠性与评测**：错误/重试 taxonomy（瞬时 vs 永久、退避、熔断，扩展 core 错误处理 + Runner 退避/熔断）；校验-修复自纠回环；重放式 eval / 轨迹回归 harness + 模拟环境。
- **横切调度/后台**：调度工具 + 实现 M8 `Scheduler` 端口的 Node adapter（时间经 `Scheduler` / `Clock` 注入，不破坏重放）。

### 1.2 现状审计

| 维度 | 当前实现 | 目标状态 |
|---|---|---|
| 权限模式 | `PermissionConfig`（`defaults` per tier + `toolOverrides`），`evaluatePermission` 纯三态，无"模式" | 增"权限模式"纯决策层（`plan` / `auto-accept` / `default` + 规则集），plan 模式写工具→`deny`（产计划不执行）、auto-accept→edits `allow` 但 `IRREVERSIBLE` 仍 `ask`；可经 `PolicyEngine` adapter 外置 |
| 外置授权 | 无；M8 立 `PolicyEngine` 端口类型（`evaluate(request) → allow/deny/ask`） | Runner 在权限分流处可选调用 `PolicyEngine`，与 core `evaluatePermission` 组合（最严生效），决策仍归一为既有 ask/deny 闭环 |
| 执行隔离 | `createNodeShell` 直接 `spawn(..., { shell: true })`，无边界 | 实现 M8 `Sandbox` adapter（macOS seatbelt / Linux landlock / 容器策略），shell/web 工具经 Sandbox；越界归一 `isError` 回喂不 crash |
| egress 管控 | `Network.fetch` 对任意 URL 放行 | egress 策略（allow/deny host 列表）在 Network/Sandbox adapter 层拦截，越权归一 `isError` |
| guardrails | 无 | 纯函数 guardrail：不可信内容（web/MCP）标注/隔离；PII 脱敏作用于 `displayMetadata` / 事件流出层 |
| secrets 作用域 | 无；M8 立 `Secrets` 端口类型 | `Secrets` adapter + 作用域绑定（按工具/会话限定可解析 ref），凭据不进 `messages` / 不落 checkpoint |
| 错误 taxonomy | `model_error.retriable?` 二分；工具错误 `isError` 回喂 | core 增错误分类纯函数（瞬时/永久/限流/越权）；Runner 按类做指数退避 + 熔断；归一回喂不抛 |
| 自纠回环 | 无（仅 M8 循环检测拦"重复失败"） | 校验-修复 loop：可声明的校验器对工具结果/产物校验失败时，向模型回喂结构化修复提示（纯决策可重放） |
| eval / 模拟 | 仅包内零散重放测试 | 新增 `@agent-core/eval`：录制轨迹格式 + 重放 runner（mock 端口）+ 断言 (state, effects) 一致 + 首个分歧点报告；模拟环境（确定性 mock 端口套件） |
| 调度/后台 | 无；M8 立 `Scheduler` 端口类型（`schedule`/`cancel`/`sleep`） | `Scheduler` Node adapter + 调度工具（创建定时/周期/后台任务）；时间经 `Scheduler`/`Clock` 注入，重放确定 |

### 1.3 设计目标

1. **门控与权限职责不混淆**：权限模式只影响"可见工具是否放行（allow/deny/ask）"——属 PermissionPolicy 维度；**绝不**触碰 ToolRouter 的"可见性门控"。两者各自独立。
2. **安全决策尽量纯**：权限模式 / 规则集 / 错误分类 / 自纠决策全部为 core 纯函数，可重放；真实隔离/网络/凭据/退避计时等副作用留在 Runner 与 adapter。
3. **越界一律归一不 crash**：沙箱越权、egress 越权、secrets 解析失败、退避耗尽，统统归一为 `isError: true` 的 `ToolResult` 或归一化终止 input 回喂，**绝不抛异常中断主循环**。
4. **消费而非重定义端口**：M11 只**实现/消费** M8 的 `Sandbox` / `Secrets` / `PolicyEngine` / `Scheduler` 端口；若 M8 尚未落地，本 Plan 以"端口契约存在"为前提推进，缺口在 Phase 0 校验并标注阻塞依赖，不在本 Plan 内新定义端口类型。
5. **吃满纯度/可重放红利**：eval harness 复用既有 `step()` 纯函数 + mock 端口，录制真实会话轨迹（input 序列 + 期望 (state, effects)），对新核心版本重放断言一致，失败给出**首个分歧点**——这是 roadmap §6 列为护城河的能力，近乎免费。
6. **调度不破坏重放**：调度时间一律经 `Scheduler` / `Clock` 端口注入；reducer 不读 wall-clock，定时/唤醒经 input 归一回喂。
7. **向后兼容**：不配置任何 M11 能力时，行为与现状完全一致（既有测试零回归）。

## 2. Goals

1. **权限模式（core 纯决策）**：在 PermissionPolicy 之上增"模式"层（`default` / `plan` / `auto-accept` + 规则集），纯函数裁决；plan 模式写/不可逆工具 → `deny`，auto-accept → `WRITE_*` 自动 `allow` 但 `IRREVERSIBLE` 仍 `ask`。
2. **PolicyEngine adapter（消费 M8 端口）**：实现可注入的外置授权 adapter，Runner 在权限分流处把 core `evaluatePermission` 与 `PolicyEngine.evaluate` 组合（取最严），决策归一回既有 ask/deny 闭环。
3. **Sandbox adapter（实现 M8 端口）**：Node 沙箱执行 runtime（macOS seatbelt / Linux landlock / 容器策略可配），shell/web 工具经 Sandbox；写越界 / 网络越权被 adapter 拦截并归一 `isError` 回喂不 crash。
4. **Guardrails + egress + secrets 作用域**：纯函数 guardrail 标注/隔离不可信内容 + PII 脱敏；egress allow/deny 策略；Secrets adapter + 作用域绑定（凭据不进 `messages` / 不落 checkpoint）。
5. **错误/重试 taxonomy + 自纠回环**：core 错误分类纯函数（瞬时/永久/限流/越权）；Runner 指数退避 + 熔断（计时在 Runner）；校验-修复自纠 loop（纯决策回喂修复提示）。
6. **重放式 eval harness + 模拟环境**：新增 `@agent-core/eval` 包——轨迹录制格式 + 重放 runner + (state, effects) 一致断言 + **首个分歧点**报告；确定性 mock 端口套件构成模拟环境。
7. **调度/后台**：`Scheduler` Node adapter + 调度工具（创建定时/周期/后台任务），时间经端口注入，重放确定。
8. 全程满足验收 + `pnpm turbo run typecheck lint test` 通过 + `check-core-zero-deps` 通过 + 既有重放测试零回归。

## 3. Non-Goals

1. **不**重新定义任何端口类型——`Sandbox` / `Secrets` / `PolicyEngine` / `Scheduler` 的接口归 M8（Plan 002）；本 Plan 仅实现/消费（边界见 §4.6）。
2. **不**实现可观测性 / OTel tracing / 指标 / 时间旅行调试器 / 审计日志——归 M12（Plan 006）。eval harness 是"离线回归"，与"在线可观测"不同物，不与 M12 重叠。
3. **不**实现具体工具如 LSP / browser / AST 编辑 / db / http——归 M10（Plan 004）。本 Plan 只对**既有** shell/web 工具接 Sandbox/egress，并新增 schedule 工具。
4. **不**实现成本账目/上报——归 M9（Plan 003）。本 Plan 的退避/熔断只依赖错误分类，不依赖成本计量。
5. **不**实现多 provider / 缓存 / RAG / 记忆——归 M9。eval mock 端口仅为模拟，不是真实 provider。
6. **不**引入 `Date.now()` / 随机 / `node:*` 进 `packages/core/`——隔离/计时/凭据全部经端口与 adapter，core 只裁决确定性维度。
7. **不**实现多 agent 编排拓扑——归 M12。

## 4. Key decisions

### 4.1 权限模式：core 增纯决策"模式"层，不动可见性门控

**决策**：在 `permission-policy.ts` 扩展 `PermissionConfig` 增 `mode?: "default" | "plan" | "auto-accept"` 与可选 `rules`（规则集：按工具名/能力/路径前缀模式匹配 → allow/deny/ask），`evaluatePermission` 升级为纯函数 `evaluatePermission(config, toolName, riskTier)`，模式作为最外层裁决：

- `plan`：所有 `WRITE_LOW` / `WRITE_HIGH` / `IRREVERSIBLE` → `deny`（只读放行，写工具一律不执行 → 模型据此产出"计划"）。
- `auto-accept`：`WRITE_LOW` / `WRITE_HIGH` → `allow`，但 `IRREVERSIBLE` 强制 `ask`（不可逆操作即便 auto-accept 也须人确认）。
- `default`：维持现状 tier 默认 + `toolOverrides`。
- 规则集优先级：`rules` 命中 > 模式裁决 > `toolOverrides` > tier 默认 > `ask` 兜底。

**理由**：权限模式天然是 PermissionPolicy（"是否放行"）的维度，必须留在纯 core 才能重放与快照测试；它**不**改变 ToolRouter 决定的"工具是否对模型可见"——门控与权限职责分离这条铁律不容混淆（plan 模式下写工具仍**可见**，只是被 `deny`，模型才能"看到工具并据此规划"）。`IRREVERSIBLE` 在 auto-accept 下仍 `ask` 是硬约束，写进默认实现而非靠配置自觉。

### 4.2 PolicyEngine：core 决策与外置 adapter 组合，取最严

**决策**：Runner 在权限分流处，先取 core `evaluatePermission` 决策，再（若注入了 `PolicyEngine`）`await policyEngine.evaluate(request)`，按 `deny > ask > allow` 的"最严生效"合并；合并结果仍归一进既有闭环（`allow` 直接执行，`ask` 走 HITL request_approval，`deny` 回喂 `isError` 结果）。`PolicyEngine` adapter 的 I/O（如查外部策略服务）失败时归一为 `deny`（fail-closed）。

**理由**：core 纯决策保证可重放基线，`PolicyEngine` 是 M8 立的"可插拔延伸"，把可能需要 I/O 的外置授权（OPA/Cedar 等）留在 Runner；最严生效避免外置 adapter 误放行；fail-closed 是安全默认。Runner 已有 `approvedToolCallIds` 闭环可直接复用。

### 4.3 Sandbox：实现 M8 端口，shell/web 经沙箱，越界归一 isError

**决策**：在 `runtimes/node` 实现 M8 `Sandbox` 端口 adapter（`createNodeSandbox(policy)`），策略字段含文件系统读写白名单、网络 egress 白名单、资源上限；按平台选后端（macOS `sandbox-exec`/seatbelt、Linux landlock/容器、兜底 `none` + 显式告警）。既有 `createNodeShell` 与 web fetch 在配置沙箱时改走 `Sandbox.run(spec)`；沙箱拒绝（写越界/网络越权/资源越限）以 `ExecEvent` 错误归一为工具的 `ToolResult { isError: true }` 回喂，**不抛**。

**理由**：M8 `Sandbox` 是"Shell 的泛化"，本就为隔离执行预留。越界归一 `isError` 而非 crash 是铁律 §3.3——模型据此自纠。平台后端可插拔 + `none` 兜底保证可移植与本地可跑（兜底显式告警，避免误以为已隔离）。

### 4.4 错误 taxonomy 在 core，退避/熔断在 Runner

**决策**：core 新增 `error-taxonomy.ts`——纯函数 `classifyError(err) → { kind: "transient" | "permanent" | "rate_limited" | "forbidden"; retriable: boolean }`，并扩展 `ModelErrorInput` / `ToolResultInput` 携带可选 `errorKind`。**退避计时与熔断状态**留在 Runner：Runner 对 `transient` / `rate_limited` 按指数退避（退避时长经注入的 `Scheduler.sleep` / `Clock`，不在 reducer 读时间）重试，连续失败达阈值触发熔断（停止重试，回喂归一化永久错误终止 input）；`permanent` / `forbidden` 不重试直接归一回喂。

**理由**：与 Plan 002 §4.3 同构——纯 reducer 读不到 wall-clock，退避/熔断本质是时间相关副作用，留 Runner；core 只提供确定性的**分类**纯函数供两侧共用，保证"同一错误两次分类一致"可重放。

### 4.5 校验-修复自纠回环：纯决策回喂修复提示

**决策**：在 core 增"校验器"纯函数挂点——工具结果（或模型产出的结构化输出）经可声明的校验规则（如 schema 校验、测试期望、lint 期望）判定失败时，reducer 不直接 `done`，而是回喂一条结构化"修复提示"消息（含失败摘要 + 期望），让模型自纠；自纠次数纳入可序列化状态并设上限（达上限归一终止，复用 §4.4 熔断思路）。校验**判定**为纯函数；真实跑测试/lint 的副作用经既有工具/Sandbox，结果回喂后再纯判定。

**理由**：自纠是"再给模型一次结构化反馈"的纯决策，天然可重放；与 M8 循环检测（拦"无意义重复失败"）互补——自纠是"有意义的引导修复"，二者都纳入计数上限防失控。

### 4.6 与其它 Plan 的边界

> 跨 Plan 归属以本节为唯一事实源，防重叠/冲突。

- **依赖 M8（Plan 002）—— 端口契约**：M11 **消费/实现** M8 在 `core/src/ports.ts` 立下的 `Sandbox` / `Secrets` / `PolicyEngine` / `Scheduler` 端口类型，**绝不重新定义**。若执行 M11 时 M8 端口尚未落地，Phase 0 校验缺口并标注阻塞（端口类型必须先由 M8 补齐），本 Plan 不私自新增端口接口。
- **vs M9（Plan 003）**：成本账目/上报、多 provider、缓存、RAG、记忆归 M9。本 Plan 退避/熔断只依赖**错误分类**不依赖成本计量；eval 的 mock 端口是模拟，不是真实 provider。
- **vs M10（Plan 004）**：LSP / browser / AST / db / http / 文件格式等**具体工具**归 M10。本 Plan 只对**既有** shell/web 工具接 Sandbox/egress，并新增 schedule 工具；不新增 M10 范畴的工具。
- **vs M12（Plan 006）**：可观测 / OTel / 指标 / 时间旅行调试 / 审计日志归 M12，多 agent 编排亦归 M12。本 Plan 的 eval harness 是**离线轨迹回归**（消费纯度/可重放），与 M12 的**在线可观测**是不同物，互不替代、互不重叠。Telemetry 端口的真实实现归 M12，本 Plan 不碰。
- **横切调度/后台**：`Scheduler` 端口类型归 M8；M11 owns 其 **Node adapter 实现 + 调度工具**（M10 期亦可落部分调度工具，本 Plan 负责把 Scheduler adapter 与重放纪律收口）。
- **权限：扩展不分裂**：本 Plan 扩展 core 既有 `PermissionPolicy`（增模式/规则集），不另起炉灶；`PolicyEngine` 是 M8 端口的实现，与 core 决策组合而非替代。

### 4.7 eval harness 落点：独立包 `@agent-core/eval`

**决策**：新增 `packages/eval`（`@agent-core/eval`），依赖 `@agent-core/core`（值导入纯函数 `step` 等，属 functional-core 执行者，合规）+ 测试期 mock 端口（复用 core 的 `mock-model-port` / `char-tokenizer`）。提供：① 轨迹录制格式（JSON：`{ stepContext, inputs: AgentInput[], expected: Array<{ state, effects }> }`）；② 重放 runner（纯喂 `step`，逐步 deep-equal）；③ **首个分歧点**报告（首个 (state, effects) 不一致的 step index + diff）；④ 模拟环境（确定性 mock 端口套件 + seeded Clock/Id/Random）。

**理由**：eval 是 SDK 之外的工具型包，独立于运行时副作用；依赖单向向下（`core ← eval`）合规。首个分歧点是 roadmap M11 验收硬要求，作为重放断言的标准输出。

## 5. 实现计划

> Phase 0（依赖校验）最先确认 M8 端口就位，零代码。随后按"低风险纯决策 → 隔离 adapter → 可靠性 → eval → 调度"递进：Phase 1 权限模式+PolicyEngine（纯决策+组合，吃既有审批闭环）；Phase 2 Sandbox+egress+secrets（最重的 adapter 工程）；Phase 3 guardrails+错误 taxonomy+自纠（纯决策 + Runner 退避/熔断）；Phase 4 eval harness+模拟环境（兑现可重放红利）；Phase 5 调度/后台。严格串行、逐 Phase review + 单独 commit。

### Phase 0: 依赖校验 — M8 端口契约就位确认

**Goal**: 确认 M8（Plan 002）的 `Sandbox` / `Secrets` / `PolicyEngine` / `Scheduler` 端口类型已落地于 `packages/core/src/ports.ts`、`index.ts` 已导出、SDK 已有兜底；缺口则标注阻塞、不私自补端口类型。

**Files covered**:
- `packages/core/src/ports.ts`（只读校验）
- `packages/core/src/index.ts`（只读校验导出）
- `packages/sdk/src/defaults.ts`（只读校验兜底）

**Tasks**:
- [ ] 校验 `ports.ts` 含 `Sandbox`（`run(spec): AsyncIterable<ExecEvent>` + 隔离策略字段）、`Secrets`（`resolve(ref)`）、`PolicyEngine`（`evaluate(request) → allow/deny/ask`）、`Scheduler`（`schedule`/`cancel`/`sleep`）端口类型
- [ ] 校验 `index.ts` 已导出上述端口类型；SDK `defaults.ts` 已有 no-op/兜底
- [ ] 若任一端口缺失 → 在本 Plan 顶部 `Depends on` 标注阻塞，记入 Risk 表，**不**在 M11 内新增端口类型（归还 M8）

**Acceptance Criteria**:
1. 四个待消费端口类型在 core 存在并导出，SDK 兜底可注入；否则阻塞依赖已显式标注、未私自重定义端口。

<!-- Backfill after execution:
**Reviewed**: <date> by reviewer
**Commit**: <hash> <subject>
-->

---

### Phase 1: 权限模式（core 纯决策） + PolicyEngine 组合

**Goal**: PermissionPolicy 增"模式"层（`default`/`plan`/`auto-accept` + 规则集）纯决策；Runner 把 core 决策与 M8 `PolicyEngine` adapter 组合（取最严），归一进既有 ask/deny 闭环。

**Files covered**:
- `packages/core/src/permission-policy.ts`（`PermissionConfig` 增 `mode` + `rules`，`evaluatePermission` 扩展）
- `packages/core/src/index.ts`（导出新类型）
- `packages/runtimes/node/src/runner.ts`（权限分流处组合 `PolicyEngine`）
- `packages/runtimes/node/src/policy-engine.ts`（新增：示例/兜底 PolicyEngine adapter）
- `packages/sdk/src/create-agent.ts`（可选注入 mode / PolicyEngine）
- 对应 `__tests__/`

**Tasks**:
- [ ] `PermissionConfig` 增 `mode?: "default" | "plan" | "auto-accept"` 与可选 `rules`（按工具名/能力/路径前缀 → allow/deny/ask）
- [ ] `evaluatePermission` 扩展：规则集 > 模式裁决 > toolOverrides > tier 默认 > ask；plan→写工具 deny；auto-accept→`WRITE_*` allow 但 `IRREVERSIBLE` 强制 ask（纯函数，保持现签名兼容，缺省 mode=default 行为不变）
- [ ] Runner：权限分流处取 core 决策，若注入 `PolicyEngine` 则 `await evaluate` 并按 `deny>ask>allow` 合并；adapter I/O 失败 → fail-closed `deny`；归一进既有 request_approval / deny 回喂闭环
- [ ] `policy-engine.ts`：allow-all 兜底 + 一个规则式示例 adapter（消费 M8 端口类型）
- [ ] 单测：plan 模式写工具被 deny（不执行）；auto-accept 下 `WRITE_HIGH` allow、`IRREVERSIBLE` 仍 ask；规则集优先级；PolicyEngine 取最严 + fail-closed
- [ ] 重放：含权限模式裁决的 input 序列两次运行 (state, effects) deep-equal

**Acceptance Criteria**:
1. **plan mode 下只读工具放行、写工具一律不执行（被 deny，产出计划）**；写工具仍对模型**可见**（门控未被触碰）。
2. **auto-accept 模式下 edits（`WRITE_*`）自动放行、`IRREVERSIBLE` 仍触发 `ask`**。
3. `PolicyEngine` 与 core 决策组合取最严；adapter 失败 fail-closed `deny`；决策归一进既有 HITL/deny 闭环。
4. 缺省（无 mode / 无 PolicyEngine）行为与现状一致；权限模式纯决策可重放（deep-equal）。

<!-- Backfill -->

---

### Phase 2: 沙箱执行 runtime + egress 管控 + secrets 作用域

**Goal**: 实现 M8 `Sandbox` / `Secrets` 端口的 Node adapter；shell/web 工具经 Sandbox 执行；egress 白名单拦截；secrets 作用域绑定。越界/越权一律归一 `isError` 回喂不 crash。

**Files covered**:
- `packages/runtimes/node/src/sandbox.ts`（新增：`createNodeSandbox(policy)`，实现 M8 `Sandbox`）
- `packages/runtimes/node/src/secrets.ts`（新增：`createNodeSecrets(scope)`，实现 M8 `Secrets`）
- `packages/runtimes/node/src/shell.ts`（沙箱模式下经 Sandbox 而非裸 spawn）
- `packages/runtimes/node/src/network.ts` 或 web 工具 adapter（egress 白名单拦截）
- `packages/sdk/src/create-agent.ts` / `defaults.ts`（可选注入 sandbox/secrets/egress 策略）
- 对应 `__tests__/`

**Tasks**:
- [ ] `createNodeSandbox(policy)`：策略含 fs 读写白名单 + egress host 白名单 + 资源上限；按平台选后端（macOS seatbelt / Linux landlock / 兜底 `none` 并显式告警）；`run(spec)` 产 `ExecEvent` 流
- [ ] shell：配置沙箱时改走 `Sandbox.run`；写越界 / 资源越限被拒 → 归一为 `ToolResult { isError: true }` 回喂，不抛
- [ ] egress：Network/web fetch 在 adapter 层按 host 白名单拦截，越权 → 归一 `isError`
- [ ] `createNodeSecrets(scope)`：实现 `resolve(ref)`，按作用域（工具/会话）限定可解析的 ref；解析的凭据**不**进 `messages`、**不**落 checkpoint（仅在 adapter 内用于实际请求）
- [ ] 单测：写越界被拦归一 isError；egress 越权归一 isError；越界**不** crash 主循环；secrets 作用域外 ref 解析失败归一；凭据不出现在 state 快照
- [ ] 平台兜底：`none` 后端在无 seatbelt/landlock 环境可跑且显式告警

**Acceptance Criteria**:
1. **沙箱：写越界 / 网络越权被 adapter 拦截，归一为 `isError` 回喂（不 crash 主循环）**。
2. shell/web 工具在配置沙箱时经 `Sandbox` 执行；未配置时行为与现状一致（向后兼容）。
3. secrets 作用域外的 ref 解析失败归一回喂；解析出的凭据不进 `messages` / 不落 checkpoint（state 快照中不含明文）。
4. 平台兜底 `none` 可跑并显式告警"未隔离"。

<!-- Backfill -->

---

### Phase 3: guardrails + 错误/重试 taxonomy + 校验-修复自纠回环

**Goal**: 纯函数 guardrail 标注/隔离不可信内容 + PII 脱敏；core 错误分类纯函数；Runner 指数退避 + 熔断；校验-修复自纠 loop（纯决策回喂修复提示）。

**Files covered**:
- `packages/core/src/guardrails.ts`（新增：纯函数注入标注 + PII 脱敏判定）
- `packages/core/src/error-taxonomy.ts`（新增：`classifyError` 纯函数）
- `packages/core/src/self-correct.ts`（新增：校验-修复决策纯函数）
- `packages/core/src/{input,state,reducer,index}.ts`（携带 `errorKind`、自纠计数字段、接入自纠回喂）
- `packages/runtimes/node/src/runner.ts`（退避/熔断计时，经注入的 Scheduler/Clock）
- 对应 `__tests__/`

**Tasks**:
- [ ] `guardrails.ts`：纯函数把 web/MCP 来源内容标注为 untrusted（注入隔离包裹/前缀），并提供 PII 脱敏判定（作用于 `displayMetadata`/事件流出，不改回喂模型的语义内容除非配置）
- [ ] `error-taxonomy.ts`：`classifyError(err) → { kind, retriable }`（瞬时/永久/限流/越权），纯函数
- [ ] input/state：`ModelErrorInput`/`ToolResultInput` 增可选 `errorKind`；state 增自纠计数与上限字段（可序列化，survives resume）
- [ ] Runner：对 `transient`/`rate_limited` 指数退避重试（退避时长经 `Scheduler.sleep`/`Clock`，**不**在 reducer 读时间），连续失败达阈值熔断 → 回喂归一化永久终止 input；`permanent`/`forbidden` 不重试直接归一回喂
- [ ] `self-correct.ts` + reducer：可声明校验器判定工具结果/产物失败 → 回喂结构化修复提示（含失败摘要+期望），自纠次数纳入上限，达上限归一终止
- [ ] 单测：注入内容被标注隔离；PII 脱敏；错误分类四类；退避后成功 / 熔断终止（计时经注入端口可重放）；自纠回喂 + 上限终止
- [ ] 重放：含 guardrail/分类/自纠的 input 序列两次运行 (state, effects) deep-equal

**Acceptance Criteria**:
1. **来自 web/MCP 的不可信内容经 guardrail 标注/隔离**；PII 脱敏作用于流出层，state 可重放。
2. 错误分类纯函数稳定（同一错误两次分类一致）；Runner 对瞬时/限流退避重试、达阈值熔断并归一终止，**不抛异常**；永久/越权不重试直接回喂。
3. 校验失败触发自纠回喂修复提示，自纠次数受上限约束、达上限归一终止；自纠决策纯函数可重放。
4. 退避/熔断/自纠的计时全部经注入的 `Scheduler`/`Clock`，reducer 不读 wall-clock。

<!-- Backfill -->

---

### Phase 4: 重放式 eval / 轨迹回归 harness + 模拟环境

**Goal**: 新增 `@agent-core/eval` 包——轨迹录制格式 + 重放 runner + (state, effects) 一致断言 + **首个分歧点**报告 + 确定性 mock 端口模拟环境。

**Files covered**:
- `packages/eval/`（新增包：`package.json` / `tsconfig` / `src/`）
- `packages/eval/src/{trajectory,replay,diff,simulate,index}.ts`
- `packages/eval/src/__tests__/`
- 根 `pnpm-workspace.yaml` / `turbo.json`（若需登记新包）

**Tasks**:
- [ ] 轨迹录制格式：JSON `{ stepContext, inputs: AgentInput[], expected: Array<{ state, effects }> }`（可由现有运行采集）
- [ ] 重放 runner：纯喂 `step(state, input, ctx)` 逐步推进，与 `expected` 逐 step deep-equal
- [ ] **首个分歧点**报告：返回首个 (state, effects) 不一致的 step index + 结构化 diff（roadmap M11 验收硬要求）
- [ ] 模拟环境：确定性 mock 端口套件（复用 core `mock-model-port` / `char-tokenizer` + seeded `Clock`/`Id`/`Random`），让一段会话可离线重放
- [ ] 录制一条覆盖"工具调用 + 权限 + 错误回喂"的样例轨迹，纳入回归
- [ ] 依赖校验：`@agent-core/eval` 仅依赖 `@agent-core/core`（值导入纯函数合规），不引运行时副作用；`check-core-zero-deps` 仍通过（core 未被污染）

**Acceptance Criteria**:
1. **eval harness：录制的会话轨迹对新核心版本重放，断言 (state, effects) 一致；失败时给出首个分歧点**（step index + diff）。
2. 模拟环境用确定性 mock 端口可离线跑完一段会话，无真实 I/O。
3. 样例轨迹纳入回归门；`@agent-core/eval` 依赖单向向下、core 零依赖不破。

<!-- Backfill -->

---

### Phase 5: 调度 / 后台任务（Scheduler adapter + 调度工具）

**Goal**: 实现 M8 `Scheduler` 端口的 Node adapter + 调度工具（创建定时 / 周期 / 后台任务）；时间经 `Scheduler`/`Clock` 端口注入，重放确定。

**Files covered**:
- `packages/runtimes/node/src/scheduler.ts`（新增：`createNodeScheduler(clock)`，实现 M8 `Scheduler`）
- `packages/tools/schedule/`（新增包 `@agent-core/tools-schedule`：schedule 工具，zod schema）
- `packages/sdk/src/{create-agent,defaults}.ts`（可选注入 scheduler）
- 对应 `__tests__/`

**Tasks**:
- [ ] `createNodeScheduler(clock)`：实现 `schedule(whenMs, ref)` / `cancel(id)` / `sleep(ms)`；定时触发经 `Clock` 基准，触发后把"唤醒"归一为 input 回喂主循环（不在 reducer 读时间）
- [ ] `@agent-core/tools-schedule`：schedule 工具（创建定时/周期/后台任务，zod schema → JSONSchema），经能力门控（缺 Scheduler adapter 时工具自动从可见集摘除，复用 ToolRouter）
- [ ] 风险/权限：调度类工具按 riskTier 归类（创建后台任务属 `WRITE_*`），受 Phase 1 权限模式约束
- [ ] 单测:用 seeded Clock 调度→触发→唤醒回喂，重放确定；cancel 生效；缺 adapter 工具不可见
- [ ] 重放:含调度/唤醒的 input 序列两次运行 (state, effects) deep-equal（时间经端口注入）

**Acceptance Criteria**:
1. `Scheduler` Node adapter 实现 M8 端口；调度工具可被模型选用，缺 adapter 时自动从可见集摘除（能力门控）。
2. 调度时间一律经 `Scheduler`/`Clock` 注入；用 seeded Clock 时调度→唤醒回喂的 (state, effects) 序列重放 deep-equal。
3. 调度工具受 Phase 1 权限模式约束（plan 模式下创建后台任务被 deny）；cancel 生效。

<!-- Backfill -->

---

## 6. Risks and mitigations

| Risk | Impact | Mitigation |
|---|---|---|
| 重新定义 M8 端口类型导致冲突 | 端口面分裂、与 M8 返工 | Phase 0 校验端口就位；M11 只实现/消费，缺口归还 M8（§4.6）；不私自新增端口接口 |
| 权限"模式"与可见性门控混淆 | 误把 plan 模式做成"隐藏写工具"，破坏门控/权限职责分离 | 模式只改 PermissionPolicy 放行决策（写工具仍可见、被 deny）；core lint + 测试断言可见集不受 mode 影响 |
| 沙箱越界/越权抛异常中断主循环 | 违反铁律 §3.3、循环崩溃 | adapter 把拒绝归一为 `ExecEvent` 错误 → `ToolResult { isError }` 回喂；测试显式断言不 crash |
| 平台无 seatbelt/landlock 时误以为已隔离 | 安全假象 | `none` 兜底后端显式告警"未隔离"；策略字段记录实际后端；文档/事件标注 |
| 退避/熔断把 wall-clock 引入 core | 破坏纯度/可重放 | 计时全部经注入 `Scheduler.sleep`/`Clock`；core 只提供 `classifyError` 纯分类；core lint 纯度规则把关；重放测试用 seeded 端口 |
| secrets 明文落入 messages / checkpoint | 凭据泄露 | 凭据仅在 adapter 内用于实际请求，不进回喂内容/不落 state；测试断言 state 快照无明文 |
| eval 包值导入 core 被误判违规 | 阻断 CI | eval 是 functional-core 执行者，值导入纯函数 `step` 合规（同 Runner/SDK 例外）；`check-core-zero-deps` 只校验 core 自身零依赖，不受影响 |
| 调度时间破坏重放 | 后台任务不可重现 | 调度/唤醒经 `Scheduler`/`Clock` 注入并归一为 input 回喂；含调度的重放测试作回归门 |
| 自纠/退避无上限导致失控循环 | 算力浪费、不终止 | 自纠次数 + 退避次数纳入可序列化状态并设上限，达上限归一终止（复用熔断思路）；与 M8 循环检测互补 |
| PolicyEngine 外置 adapter 误放行 | 越权执行 | core 决策与 PolicyEngine 取最严（`deny>ask>allow`）；adapter I/O 失败 fail-closed `deny` |
