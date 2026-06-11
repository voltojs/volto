# Plan 007 — M13 扩展性 & DX（插件 / hooks / 命令 / skills / 声明式 agent / 分层配置）

> **Status**: Draft
> **Owner**: TBD
> **Created**: 2026-06-09
> **Depends on**: 演进路线图 [docs/roadmap.md](../docs/roadmap.md) M13；架构设计 [docs/pure-agent-core.md](../docs/pure-agent-core.md)；Plan 001（M1–M7 已交付）；Plan 002（M8：内核引擎深化 + 9 个纯类型端口契约，含 `ToolSource` / `PolicyEngine`）；Plan 003（M9：模型层 + 项目指令分层加载 `@import`）；Plan 004（M10：MCP 客户端）
> **Target area**: `packages/sdk/src/{create-agent,defaults}.ts`（插件装配 / 配置合并 / 规格 loader 接线）、`packages/runtimes/node/src/runner.ts`（生命周期 hook 事件点）、`packages/core/src/{reducer,input,effect,state}.ts`（hook 阻断的纯决策表达）、新增 `packages/sdk/src/{plugin,hooks,commands,skills,agent-spec,config}.ts`

## 1. 背景

### 1.1 问题陈述

M1–M12 把内核做成了一个**功能完备**（编排 / 模型 / 工具 / 安全 / 可观测）且**高可移植**的核心，但"对外可扩展"这一不变量仅在端口层面成立：M8 已立 `ToolSource` 等 9 个纯类型端口契约，M10 已经能接 MCP 工具，可这些扩展点目前**只能由宿主在 `createAgent` 里手写 wiring 注入**，缺少一条"第三方以包的形式声明能力、内核自动装配"的统一通路。要兑现 roadmap 的"模块化"主张——**新增能力靠注入而非改核心**——M13 须把以下五类 DX 资产收敛为一等公民：

- **插件系统**：把工具 / provider / hook 打成可安装包，经统一注册协议装配；工具仍走 M8 `ToolSource` 动态注入与既有能力门控。
- **hooks / 中间件**：在 Runner 暴露 session 生命周期 + pre/post tool-use 事件点，允许观察 / 改写 / **阻断**（产出 `deny`），且阻断这一**纯决策**仍可表达为输入 / 效果而不破坏核心纯度。
- **斜杠命令**：用户级 / 项目级的 prompt 模板 + 参数，展开为 `UserMessage`。
- **skills**：可发现、按需加载的能力包（元数据 + 触发条件 + 资源），消费 M9 指令加载机制。
- **声明式 agent / 子 agent 规格**：把 prompt + tools + model + policy 表达为可序列化数据，由 loader 实例化为可运行 agent。
- **分层配置**：全局 / 项目 / 运行时三层，按确定优先级合并。

本 Plan 落地这套"平台化扩展层"，核心约束是：**所有扩展都不得让核心包退守纯度**——副作用永远落在 Runner / SDK shell，纯决策（如 hook 是否阻断、配置如何合并、规格如何映射为 `StepContext`）保持纯函数。

### 1.2 现状审计

| 维度 | 当前实现 | 目标状态 |
|---|---|---|
| 工具 / provider 注册 | `createAgent` 内手写 wiring：`tools?: Tool[]` 静态数组 + 内建 adapter 工具拼接（`create-agent.ts` line 187–220）；provider 由宿主直接 `new` 后传 `modelPort` | 第三方"插件包"声明 `register(registry)`，统一装配工具（经 `ToolSource`）/ provider / hook，**无需改 `create-agent.ts` 核心装配逻辑** |
| 生命周期事件点 | Runner 只在工具结果上 emit；无 session-start/end、无 pre/post tool-use 的可拦截切面（`runner.ts` line 318–416 主循环内联） | Runner 暴露命名生命周期点（session:start/end、turn:start/end、preToolUse、postToolUse），按注册顺序调用 hook，hook 可返回改写 / 阻断决策 |
| tool-use 阻断 | 仅 `PermissionPolicy`（allow/deny/ask）经 `evaluatePermission` 纯决策 + `ask` 走审批闭环 | hook 可在权限判定**之前/之后**插入额外裁决，命中阻断时与权限 `deny` 走同一归一化路径（`tool_result` `isError`，绝不抛异常中断循环） |
| 斜杠命令 | 无；CLI `main.ts` 仅原样转发用户输入 | 命令定义（名称 + 模板 + 参数 schema）注册后，输入 `/name args` 在 SDK 边界展开为 `UserMessage`，纯函数渲染 |
| skills | 无 | skills 清单可发现（用户级 / 项目级目录），元数据 + 触发条件 + 可按需加载的资源；加载机制复用 M9 指令分层 |
| 声明式 agent 规格 | 子 agent 仅由 `createSubAgentExecutor` 命令式构造（`create-agent.ts` line 466–537） | agent / 子 agent 规格为可序列化数据（prompt + tools + model + policy + capabilities），loader 纯映射为 `StepContext` / 注入集后实例化 |
| 配置 | `CreateAgentOptions` 单层、全靠调用方拼装；无全局 / 项目层 | 三层（全局 `~/.agent` < 项目 `.agent` < 运行时 `CreateAgentOptions`），纯函数按确定优先级深合并，来源可追溯 |

> 说明：M8（Plan 002）已落地 `ToolSource` / `PolicyEngine` 端口，M9 已实现指令分层加载（`@import`），M10 已实现 MCP 客户端（`McpToolSource`）。本 Plan 只**消费 / 包装**这些已有机制，绝不重新定义端口类型或重做指令加载 / MCP 客户端。

### 1.3 设计目标

1. **注入而非改核心**：第三方插件注册工具 / provider / hook，`packages/core` 与 `create-agent.ts` 的核心装配路径零改动即可生效（新增逻辑收敛在新模块 + 注册表）。
2. **纯度不退守**：hook 的副作用在 Runner / SDK；hook 的"是否阻断"是纯决策，经 `tool_result(isError)` 或权限归一路径表达，核心 reducer 不感知 hook 概念。
3. **能力门控不旁路**：插件经 `ToolSource` 动态注入的工具，仍统一过 `filterVisibleTools`（能力门控）+ `PermissionPolicy`（放行），不得绕过任一关。
4. **声明即数据**：agent / 子 agent 规格、命令、skills 清单、配置都是可序列化数据；loader / 合并 / 渲染都是纯函数，支持快照测试。
5. **优先级确定**：分层配置合并顺序固定为 **全局 < 项目 < 运行时**，冲突结果可预测、来源可追溯。
6. **向后兼容**：不传任何插件 / hook / 命令 / 配置层时，`createAgent({ modelPort })` 与既有用例零回归。

## 2. Goals

1. **插件协议 + 注册表**：定义 `Plugin` 契约（`register(registry)` 声明 tools / provider / hooks / commands / skills / agentSpecs）与 `PluginRegistry`；`createAgent` 接受 `plugins?: Plugin[]`，装配产物经既有 `ToolSource` / 能力门控 / 权限策略统一接入。
2. **生命周期 hooks**：Runner 暴露 `session:start` / `session:end` / `turn:start` / `turn:end` / `preToolUse` / `postToolUse` 事件点；hook 可观察、改写（如 redact 工具输入 / 输出），并在 `preToolUse` 阻断（产出 `deny`），阻断走与权限 `deny` 一致的归一化回喂。
3. **斜杠命令**：命令注册（名称 + prompt 模板 + 参数 schema + 作用域 用户/项目）；SDK 边界把 `/name args` 纯函数渲染为 `UserMessage`，未知命令归一为提示而非抛错。
4. **skills**：skills 清单发现（用户级 / 项目级），元数据（name / description / trigger / 资源引用），按需加载其指令片段（复用 M9 `@import` 加载，不重做）。
5. **声明式 agent / 子 agent 规格 loader**：`AgentSpec` 可序列化（prompt + tools + model + policy + capabilities + enableTaskTool）；`loadAgentSpec(spec, ports)` 纯映射 + 装配为可运行 `AgentInstance` / `SubAgentExecutor`。
6. **分层配置**：`LayeredConfig` 三层来源（全局 / 项目 / 运行时），纯函数 `mergeConfig(global, project, runtime)` 按确定优先级深合并、产出带来源标注的结果，喂入 `createAgent`。
7. 全程满足验收 + `pnpm turbo run typecheck lint test` 通过 + `check-core-zero-deps` 通过 + 既有重放 / HITL / resume 测试零回归。

## 3. Non-Goals

1. **不**重新定义任何 M8 端口类型（`ToolSource` / `PolicyEngine` 等以 Plan 002 落地的契约为准；本 Plan 仅消费 / 实现）。
2. **不**实现 MCP 客户端本身（归 M10 / Plan 004）；插件系统只"包装 / 注册"已由 M10 提供的 MCP 工具源。
3. **不**重做项目指令分层加载与 `@import` 展开（归 M9 / Plan 003）；skills / 命令仅**引用**该机制加载资源。
4. **不**实现具体宿主形态（headless server / IDE / browser runtime，归 M14 / Plan 008）；本 Plan 只在 SDK + 参考 CLI 内验证扩展层。
5. **不**实现具体业务工具（归 M10）；插件示例仅用最小占位工具佐证"第三方注册"通路。
6. **不**引入插件远程下载 / 沙箱化执行不可信插件代码（安全隔离归 M11 / Plan 005）；M13 假设插件为本地受信代码。
7. **不**把 hook / 插件概念渗进 `packages/core`：核心不新增"hook"类型，阻断一律落在既有归一化路径上。

## 4. Key decisions

### 4.1 插件协议：声明式 `register(registry)`，装配在 SDK，门控不旁路

**决策**：`Plugin` 是一个带 `name` 与 `register(registry: PluginRegistry): void` 的对象。`register` 内通过 registry 的 `addTool` / `addProvider` / `addHook` / `addCommand` / `addSkill` / `addAgentSpec` 声明产物。`createAgent` 收集所有插件 → 构建一个组合 `ToolSource`（插件工具 + 内建 adapter 工具）→ 仍走 `filterVisibleTools`（能力门控）与 `PermissionPolicy`（放行）。provider 注册进 provider 表，按名选用 / 路由（路由本体归 M9，本 Plan 仅注册）。

**理由**：声明式注册让"加能力"与"核心装配"解耦——`create-agent.ts` 只多一步"遍历插件喂注册表"，核心 reducer / Runner 主循环零改动即满足"无需改核心"。复用 `ToolSource` 而非另造工具注入通道，保证动态工具与 MCP / 静态工具同源、同门控。

### 4.2 hooks：Runner 暴露生命周期点，副作用在 shell，阻断走纯归一化路径

**决策**：在 Runner 主循环的固定切点调用 hook 管线：`session:start`（`run` 入口）/ `turn:start`（进入 `calling_model` 前）/ `preToolUse`（`executeTool` 前、权限判定一并纳入）/ `postToolUse`（拿到 `ToolResult` 后、回喂 reducer 前）/ `turn:end` / `session:end`。hook 返回 `HookOutcome`：`{ action: "continue" }` | `{ action: "modify", patch }`（改写工具 input / result）| `{ action: "deny", reason }`。`preToolUse` 命中 `deny` 时，Runner **不调用 toolExecutor**，直接构造 `{ modelContent: reason, isError: true }` 的 `ToolResult` 回喂——与权限 `deny`（`runner.ts` line 351–360）完全同路。

**理由**：hook 的真实副作用（读环境 / 写日志 / 调外部）只发生在 Runner 这一 imperative shell；核心 reducer 仍只见 `tool_result(isError)`，不引入"hook"类型，纯度与可重放不破。把阻断与权限 `deny` 收敛到同一归一化出口，保证"错误不中断循环"铁律对 hook 同样成立。hook 管线本身按注册顺序串行、可被 `AbortSignal` 取消，行为确定。

### 4.3 hook 阻断 vs PermissionPolicy：职责分层，先权限后 hook

**决策**：保持 CLAUDE.md 的"门控 / 权限"职责分离不变，hook 是**第三道**正交切面：① `filterVisibleTools`（能力门控：是否可见）→ ② `PermissionPolicy`（allow/deny/ask：是否放行）→ ③ `preToolUse` hooks（业务策略：注入防御 / 配额 / 自定义 deny）。三者任一 deny 即归一化阻断；ask 仍只由权限层经审批闭环处理（hook 不产生 ask，避免与 HITL 语义打架）。

**理由**：能力门控决定"可见"、权限决定"放行"、hook 决定"业务侧附加约束"，互不僭越。hook 只产 `continue` / `modify` / `deny`，把 HITL 的 `ask` 留给权限层独占，避免审批语义出现两个来源。

### 4.4 声明式 agent 规格：可序列化数据 + 纯 loader

**决策**：`AgentSpec` 是纯数据：`{ name, systemPrompt, model?, maxTokens?, temperature?, tools: string[]（按名引用注册表）, capabilities?: string[], policy?: PermissionConfig, enableTaskTool? }`。`loadAgentSpec(spec, ports, registry)` 是纯映射函数：把 spec 解析为 `StepContext` + 工具子集 + capability 集 + permission 配置，再交给现有 `createAgent` / `createSubAgentExecutor` 实例化。子 agent 规格复用同一结构，由 `task` 工具按名选用。

**理由**：规格是数据 → 可从配置文件 / 插件加载、可快照测试、可序列化进 checkpoint。loader 纯映射不碰 I/O，把"实例化"这一副作用留给已有的 SDK 装配路径，零新增纯度风险。子 agent 与主 agent 同构，避免两套规格。

### 4.5 分层配置：全局 < 项目 < 运行时，纯函数深合并 + 来源标注

**决策**：三层配置源——全局（如 `~/.agent/config`）、项目（如 `<cwd>/.agent/config`）、运行时（`CreateAgentOptions`）。读取由 Runtime adapter（fs）完成（shell 侧），合并由纯函数 `mergeConfig(layers)` 完成：标量 / 对象后者覆盖前者，数组按字段策略（默认 concat 去重，可声明 replace），并产出 `resolvedFrom` 来源映射。最终 `ResolvedConfig` 喂 `createAgent`。

**理由**：把"读文件"（副作用）与"合并"（纯决策）拆开，合并可快照测试、优先级可断言。固定 全局 < 项目 < 运行时 顺序消除歧义，来源标注让用户能追溯"某项值从哪层来"，是 DX 关键。

### 4.6 命令 / skills：纯渲染 + 复用 M9 加载，不重做指令机制

**决策**：斜杠命令 = `{ name, scope: "user"|"project", template, args: JSONSchema }`；`renderCommand(cmd, rawArgs)` 纯函数把模板 + 参数渲染为 `UserMessage` 文本，未知命令返回归一化提示文本（不抛错）。skills = `{ name, description, trigger, resources: string[] }`，资源加载**直接复用 M9 的指令分层 / `@import` 展开**，本 Plan 不实现任何加载器，只在装配期登记可发现的 skills 清单并按需引用其展开结果。

**理由**：命令渲染是确定性字符串变换，纯函数即可、易测。skills 的"加载"与"展开"是 M9 owns 的能力，M13 只做"发现 + 元数据 + 触发登记 + 引用"，严格不越界。

### 4.7 与其它 Plan 的边界

> 本节是防重叠的硬约束，落地时逐条对照。

- **与 M8（Plan 002）端口契约**：`ToolSource` / `PolicyEngine` 等 9 个端口类型由 M8 定义，**本 Plan 不新增、不修改端口类型**。插件工具源实现 `ToolSource` 接口；hook 的可插拔授权若需外置，复用 `PolicyEngine` 端口而非另造。
- **与 M9（Plan 003）指令加载**：项目指令分层加载（CLAUDE.md / AGENTS.md 发现 + `@import` 递归展开）归 M9。本 Plan 的 skills / 命令**只引用**该加载机制装填资源，**绝不重做** `@import` 或指令发现。M9 落地前，skills 资源加载以"占位 / 注入点"形式预留，待 M9 接通。
- **与 M10（Plan 004）MCP 客户端**：MCP 客户端本体（连接 server、列工具 / 资源 / prompt）归 M10。本 Plan 的插件系统**只包装 / 注册** M10 暴露的 MCP `ToolSource`，把"一个 MCP server"封装为"一个插件"，**不实现 MCP 协议**。
- **与 M11（Plan 005）安全隔离**：不可信插件的沙箱化执行、注入防御 guardrail 本体归 M11。M13 假设插件为本地受信代码；hook 提供"切面"，具体注入防御策略作为 hook 的一个**消费方**由 M11 落地。
- **与 M12（Plan 006）可观测 / 多 agent**：结构化 Telemetry span 归 M12（消费 M8 `Telemetry` 端口）；hook 的 `postToolUse` 可发事件，但 OTel 导出本体归 M12。多 agent 编排拓扑归 M12；本 Plan 的声明式 agent 规格是其"数据底座"，但不实现 supervisor / pipeline 拓扑。
- **与 M14（Plan 008）宿主**：具体宿主形态归 M14。本 Plan 仅在 SDK + 参考 CLI 内验证扩展层。

## 5. 实现计划

> Phase 1（分层配置）与 Phase 2（插件协议 + 注册表）是地基，先落地；Phase 3（Runner 生命周期 hooks + 阻断）是核心改造与最大纯度风险点；Phase 4（声明式 agent 规格 loader）依赖注册表；Phase 5（斜杠命令 + skills）做 DX 收口。严格串行、逐 Phase review + 单独 commit。

### Phase 1: 分层配置（全局 < 项目 < 运行时，纯合并）

**Goal**: 三层配置源经纯函数 `mergeConfig` 按确定优先级深合并，产出带来源标注的 `ResolvedConfig`，喂入 `createAgent`；读取（I/O）在 SDK / runtime 层，合并在纯函数。

**Files covered**:
- `packages/sdk/src/config.ts`（新增：`LayeredConfig` / `ResolvedConfig` 类型、纯 `mergeConfig`、来源标注）
- `packages/sdk/src/defaults.ts`（配置读取兜底：缺省层为空）
- `packages/sdk/src/create-agent.ts`（接受 `config?: ResolvedConfig`，映射进 `CreateAgentOptions`）
- `packages/sdk/src/index.ts`（导出配置 API）
- 对应 `__tests__/`

**Tasks**:
- [x] 定义 `LayeredConfig`（单层形状）与 `ResolvedConfig`（含 `resolvedFrom` 来源映射）类型
- [x] 实现纯函数 `mergeConfig(global, project, runtime)`：标量 / 对象后覆盖前；数组默认 concat 去重、可字段级声明 replace；记录每个生效字段来源
- [x] SDK 侧读取入口（经注入的 fs adapter 读全局 / 项目配置文件；缺失即空层），与纯合并解耦
- [x] `createAgent` 接受 `config?: ResolvedConfig`，将其映射为现有 `CreateAgentOptions` 字段（运行时 opts 仍最高优先级）
- [x] 测试：合并优先级（全局 < 项目 < 运行时）；数组 concat/replace；来源标注正确；缺省层不影响行为；最小配置零回归

**Acceptance Criteria**:
1. 同一字段三层都有值时，最终取**运行时**值；仅全局 + 项目时取项目值——优先级确定、有测试覆盖。
2. `mergeConfig` 为纯函数（同输入同输出，无 I/O），可快照测试；`resolvedFrom` 能追溯每个字段来源。
3. 不提供任何配置层时，`createAgent({ modelPort })` 行为与现状一致（向后兼容）。

**Reviewed**: 2026-06-11 by reviewer
**Commit**: b45c64e feat(plan-007): phase 1 — 分层配置（mergeConfig 纯函数 + createAgent 接入）

---

### Phase 2: 插件协议 + 注册表（工具 / provider / hook 装配）

**Goal**: 定义 `Plugin` / `PluginRegistry` 契约；`createAgent` 接受 `plugins?`，遍历装配工具（经组合 `ToolSource` + 能力门控 + 权限策略）/ provider / hook，核心装配路径无需为新增能力改动。

**Files covered**:
- `packages/sdk/src/plugin.ts`（新增：`Plugin` / `PluginRegistry` 类型、`collectPlugins` 装配、组合 `ToolSource` 构造）
- `packages/sdk/src/create-agent.ts`（接受 `plugins?`，注册表产物接入既有 tools / capabilities / provider 装配）
- `packages/sdk/src/defaults.ts`（空注册表兜底）
- `packages/sdk/src/index.ts`（导出插件 API）
- 对应 `__tests__/`（含一个最小示例插件）

**Tasks**:
- [x] 定义 `Plugin = { name; register(registry): void }` 与 `PluginRegistry`（`addTool` / `addProvider` / `addHook` / `addCommand` / `addSkill` / `addAgentSpec`）
- [x] 实现 `collectPlugins(plugins)`：调用各 `register`，聚合产物；工具聚合为实现 M8 `ToolSource` 的组合源
- [x] `createAgent`：把插件工具与内建 adapter 工具合并进 `ToolSource`，统一过 `filterVisibleTools`（门控）+ `PermissionPolicy`（放行）；provider 入注册表按名选用
- [x] 插件声明的所需 capability 并入 `availableCapabilities`；缺对应能力时该工具自动从可见集摘除（复用既有门控）
- [x] 测试：示例插件注册一个占位工具 → 工具进入可见集、可被 mock 模型选用、结果归一回喂；`packages/core` 与 `create-agent.ts` 核心 reducer / 主循环装配逻辑无需为该插件改动
- [x] 测试：插件工具缺能力时不可见；注册重名工具的去重 / 报错策略

**Acceptance Criteria**:
1. **第三方包以插件形式注册工具 / provider / hook，无需改核心**：示例插件经 `plugins:[...]` 注入后其工具可被模型选用、结果回喂；改动仅限插件包自身 + 注册表遍历，`packages/core` 零改动。
2. 插件工具经 `ToolSource` 注入后仍统一过能力门控与权限策略；缺能力自动摘除（不旁路任一关）。
3. `check-core-zero-deps` 通过；最小配置（无 `plugins`）零回归。

**Reviewed**: 2026-06-11 by reviewer
**Commit**: 3af6b20 feat(plan-007): phase 2 — 插件协议 + 注册表（Plugin / PluginRegistry / collectPlugins）

---

### Phase 3: Runner 生命周期 hooks + tool-use 阻断（纯归一化）

**Goal**: Runner 暴露 session / turn / pre-post tool-use 生命周期点；hook 可观察 / 改写 / 阻断；`preToolUse` 阻断走与权限 `deny` 一致的 `tool_result(isError)` 归一化回喂，核心不感知 hook 概念、可重放不破。

**Files covered**:
- `packages/sdk/src/hooks.ts`（新增：`Hook` / `HookOutcome` / `HookPipeline` 类型、按注册顺序串行调用、纯决策聚合）
- `packages/runtimes/node/src/runner.ts`（在 `run` / `runLoop` / `executeTool` 固定切点调用 hook 管线；阻断 → 归一化 `tool_result`）
- `packages/runtimes/node/src/index.ts`（导出 hook 接线类型 / RunnerOptions 扩展 `hooks?`）
- `packages/sdk/src/create-agent.ts`（把插件 / 配置注册的 hooks 传入 Runner）
- 对应 `__tests__/`（含 deny / modify / 顺序 / 重放）

**Tasks**:
- [x] 定义 `Hook`（命名生命周期点 + 处理函数）、`HookOutcome = continue | modify(patch) | deny(reason)`、`HookPipeline`（按注册顺序串行执行、首个 deny 短路）
- [x] Runner：在 `run` 入口 emit `session:start`、结束 emit `session:end`；进入 `calling_model` 前 `turn:start`、turn 收束 `turn:end`
- [x] Runner：`executeTool` 前跑 `preToolUse`（在权限判定之后、`toolExecutor` 之前）；`deny` → **不执行工具**，构造 `{ modelContent: reason, isError: true }` 回喂（与 `runner.ts` 现有权限 deny 同路，line 351–360）；`modify` → 用 patch 后的 input 执行
- [x] Runner：拿到 `ToolResult` 后跑 `postToolUse`，允许 `modify`（如 redact 输出）后再回喂 reducer
- [x] hook 管线副作用全在 Runner；reducer 不新增 hook 类型；hook 决策确定 → 同输入序列重放 (state, effects) deep-equal
- [x] 测试:`preToolUse` deny → 工具未执行、模型收到 isError 结果、循环继续不抛异常；`modify` 改写 input/output 生效；多 hook 注册顺序确定；含 hook 的重放 deep-equal

**Acceptance Criteria**:
1. **hooks：pre/post tool-use 可拦截、改写、阻断（产出 deny）**：`preToolUse` 返回 deny 时工具不执行、结果归一为 `isError` 回喂、主循环不中断；`modify` 能改写工具 input / result。
2. session / turn / pre-post tool-use 六个生命周期点按固定切点触发，多 hook 按注册顺序串行、首个 deny 短路。
3. hook 副作用仅在 Runner；`packages/core` 不新增 hook 概念；含 hook 的 input 序列两次运行 (state, effects) deep-equal（可重放）。

**Reviewed**: 2026-06-11 by reviewer
**Commit**: pending

---

### Phase 4: 声明式 agent / 子 agent 规格 loader

**Goal**: `AgentSpec` 为可序列化数据；纯 `loadAgentSpec` 映射为装配参数后实例化为可运行 agent / 子 agent，子 agent 与主 agent 同构。

**Files covered**:
- `packages/sdk/src/agent-spec.ts`（新增：`AgentSpec` 类型、纯 `resolveAgentSpec(spec, registry) → 装配参数`、`loadAgentSpec(spec, ports, registry) → AgentInstance`）
- `packages/sdk/src/create-agent.ts`（`createSubAgentExecutor` 改为可由 `AgentSpec` 驱动；保留命令式路径兼容）
- `packages/sdk/src/index.ts`（导出规格 API）
- 对应 `__tests__/`

**Tasks**:
- [ ] 定义 `AgentSpec`（`name` / `systemPrompt` / `model?` / `maxTokens?` / `temperature?` / `tools: string[]` / `capabilities?` / `policy?` / `enableTaskTool?`），全部可序列化
- [ ] 纯函数 `resolveAgentSpec(spec, registry)`：按名解析 `tools` 为工具子集、组装 `StepContext` / capability 集 / permission 配置（无 I/O）
- [ ] `loadAgentSpec(spec, ports, registry)`：用解析结果走现有 `createAgent` 装配实例化为 `AgentInstance`
- [ ] 子 agent：`task` 工具按名选用子 agent 规格；`createSubAgentExecutor` 接受 `AgentSpec` 驱动（去任务工具防递归逻辑保留）
- [ ] 测试：从 spec 数据加载并实例化 → 跑通一轮（mock 模型）；规格序列化 / 反序列化往返一致；按名引用未注册工具的归一化报错

**Acceptance Criteria**:
1. **声明式 agent 规格可加载并实例化运行**：给定 `AgentSpec` 数据，`loadAgentSpec` 产出的 `AgentInstance` 能跑通一轮对话（mock 模型）。
2. `resolveAgentSpec` 为纯函数（无 I/O），规格可序列化往返一致、可快照测试。
3. 子 agent 规格与主 agent 同构，经 `task` 工具按名实例化；既有命令式子 agent 路径零回归。

<!-- Backfill -->

---

### Phase 5: 斜杠命令 + skills（纯渲染 + 复用 M9 加载）

**Goal**: 斜杠命令注册 + 纯渲染为 `UserMessage`；skills 清单发现 + 元数据 + 触发登记，资源加载复用 M9 指令机制，不重做加载器。

**Files covered**:
- `packages/sdk/src/commands.ts`（新增：`SlashCommand` 类型、纯 `renderCommand`、命令注册查表）
- `packages/sdk/src/skills.ts`（新增：`Skill` 类型、清单发现 / 登记；资源加载委托 M9 注入点）
- `packages/sdk/src/create-agent.ts`（输入归一化前拦截 `/name`，展开为 `UserMessage`）
- `apps/reference-cli/src/main.ts`（演示斜杠命令输入路径）
- `packages/sdk/src/index.ts`（导出命令 / skills API）
- 对应 `__tests__/`

**Tasks**:
- [ ] 定义 `SlashCommand`（`name` / `scope` / `template` / `args: JSONSchema`）；纯函数 `renderCommand(cmd, rawArgs) → string`；未知命令归一为提示文本（不抛错）
- [ ] `createAgent`：在 `normalizeInput` 前识别 `/name args`，命中则经 `renderCommand` 展开为 `UserMessage`
- [ ] 定义 `Skill`（`name` / `description` / `trigger` / `resources: string[]`）；skills 清单发现（用户级 / 项目级目录）+ 元数据登记
- [ ] skills 资源加载：**委托 M9 指令加载 / `@import` 展开**（以注入点 / 接口预留；M9 未接通前以占位实现 + 测试桩验证登记路径）
- [ ] 参考 CLI：演示 `/foo` 输入展开为用户消息后正常进主循环
- [ ] 测试:`renderCommand` 模板 + 参数渲染快照；未知命令归一提示；skills 清单发现 + 元数据正确；skills 资源加载走 M9 注入点（不重复实现 `@import`）

**Acceptance Criteria**:
1. 注册斜杠命令后，输入 `/name args` 在 SDK 边界被纯函数渲染为 `UserMessage` 并进主循环；未知命令归一为提示（不抛错）。
2. skills 清单可发现（用户级 / 项目级），元数据（name / description / trigger / 资源引用）完整；资源加载**复用 M9 机制**，本 Plan 不实现 `@import`（以注入点对接）。
3. `renderCommand` / skills 发现为纯函数 / 确定性，可快照测试；参考 CLI 演示通过。

<!-- Backfill -->

---

## 6. Risks and mitigations

| Risk | Impact | Mitigation |
|---|---|---|
| hook 副作用渗入核心破坏纯度 / 可重放 | 重放测试失效、核心退守为非纯 | hook 副作用全锁在 Runner shell；reducer 不新增 hook 类型；阻断走既有 `tool_result(isError)` 归一路径；新增"含 hook 的重放 deep-equal"测试作回归门 |
| 插件注入工具旁路能力门控 / 权限策略 | 未授权工具被模型选用、安全回退 | 插件工具统一经 M8 `ToolSource` + `filterVisibleTools` + `PermissionPolicy`，不另开工具注入通道；测试断言缺能力即摘除 |
| 与 M9 指令加载 / M10 MCP 客户端职责重叠 | 重复实现、双源冲突 | §4.7 边界硬约束：skills/命令只引用 M9 加载、插件只包装 M10 MCP 源；M9/M10 未合入前以注入点 / 占位对接，绝不重做 |
| 端口契约被本 Plan 私自扩展 | 与 M8 契约漂移、后续返工 | 不新增 / 不改 M8 端口类型；需外置授权用 `PolicyEngine`，需动态工具用 `ToolSource`，均消费既有契约 |
| hook deny 与 PermissionPolicy ask 语义打架 | 审批来源歧义、HITL 错乱 | §4.3 职责分层：hook 只产 continue/modify/deny，ask 由权限层独占；顺序固定 门控→权限→hook |
| 分层配置合并顺序歧义 | 配置结果不可预测、难排障 | 固定 全局<项目<运行时；合并为纯函数 + 来源标注；优先级断言入测试 |
| 不可信插件代码执行带来安全风险 | 任意代码执行 | M13 显式假设插件本地受信（Non-Goal 6）；沙箱化执行归 M11；文档标注信任边界 |
| 声明式规格与命令式子 agent 双路径分叉 | 行为不一致、维护负担 | 子 agent 与主 agent 同构、共用 `resolveAgentSpec`；命令式路径保留但以 spec 路径为主，回归测试覆盖两路 |
