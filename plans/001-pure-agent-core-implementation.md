# Plan 001 — 纯 Agent 核心(Pure Agent Core)项目架构与落地

> **Status**: Draft
> **Owner**: TBD
> **Created**: 2026-06-03
> **Depends on**: 架构设计文档 [docs/pure-agent-core.md](../docs/pure-agent-core.md)
> **Target area**: 全新 monorepo —— `packages/core`、`packages/tools/*`、`packages/providers/*`、`packages/runtimes/*`、`packages/stores/*`、`packages/sdk`、`apps/reference-cli`

## 1. 背景

### 1.1 问题陈述

[docs/pure-agent-core.md](../docs/pure-agent-core.md) 定义了一个"零环境耦合、零副作用核心、能力即注入"的通用 agent 内核架构,但仅停留在设计层面,尚无任何代码。本 Plan 的任务是把该架构文档落地为一个**可运行、可测试、可移植**的 TypeScript monorepo:从纯函数内核(M1)到子 Agent + SDK + 参考 CLI 宿主(M7)的完整实现。

核心设计约束(来自架构文档,不可妥协):

- **核心包零运行时依赖、零 I/O**:不出现 `Date.now()` / `Math.random()` / 直接 `fs`,一律走 port 注入。
- **Functional Core / Imperative Shell**:核心是纯转移函数 `step(state, input) → { state, effects[] }`,真正的副作用由薄 Runner 解释执行。
- **依赖单向向下**:`core ← tools-*/provider-*/runtime-*/store-* ← sdk ← apps/*`;`zod` 仅在工具包与 SDK 层引入。
- **能力即注入**:工具声明 `requires: Capability[]`,宿主未注入对应 port 时该工具自动从可见工具集摘除。

### 1.2 现状审计

| 维度 | 当前实现 | 目标状态 |
|---|---|---|
| 代码 | 仅有 `docs/pure-agent-core.md` 一份设计文档 | 完整 pnpm + Turborepo monorepo,M1–M7 全量落地 |
| 仓库 | 非 git 仓库(`git status` 报错) | 已 `git init`,有 feature 分支与 Phase 提交历史 |
| 核心 | 无 | 纯函数 `step()` reducer + 全部 port 接口 + 重放测试 |
| 工具 | 无 | 文件 / shell / web / planning / 子 agent 五类工具包,Zod 校验 + 能力门控 |
| 适配层 | 无 | OpenAI 兼容 ModelPort、Node 文件/shell/network adapter、内存 + file SessionStore |
| 对外 API | 无 | SDK 门面 `run / stream / resume`,最小配置仅需一个 model |
| 宿主 | 无 | 一个参考 CLI,仅做 wiring,核心包零改动即可跑通 |

### 1.3 设计目标

1. **纯函数内核可重放**:同一串 input 序列两次运行产生完全一致的 (state, effects) 序列。
2. **薄解释器可移植**:同一核心 + 工具包,替换 ports adapter 即可换宿主环境。
3. **能力门控自动收缩**:缺失某 port → 依赖该能力的工具对模型不可见。
4. **接口最小化**:核心仅 import port 接口类型,绝不 import 任何实现。
5. **端到端可用**:参考 CLI 仅通过 wiring 跑通"对话 → 工具 → 结果回喂 → 最终回复"完整流程。

## 2. Goals

1. 建立 pnpm + Turborepo monorepo 骨架,确立单向向下的包依赖边界并由工具强制(`packages/core` 无任何 `dependencies`)。
2. 实现 `@agent-core/core`:`AgentState` / `AgentInput` / `Effect` 类型、`step()` reducer、ContextAssembler / Compactor / ToolRouter / PermissionPolicy 纯决策、全部 port 接口。
3. 实现薄 Runner(effect 解释器),支持同步与异步执行、取消(AbortSignal)。
4. 实现 OpenAI 兼容 ModelPort adapter,流式归一化 text / reasoning / tool_use / usage;附带 mock ModelPort。
5. 实现文件工具包(read/edit/write/ls/glob/grep),`edit_file` 支持 str_replace + fuzzy fallback + 先读后改 + 版本比对;附 Node 文件 adapter(工作区边界)。
6. 实现 ContextAssembler(cache 友好排序)、Tokenizer adapter、Compactor 压缩决策。
7. 实现 PermissionPolicy、RequestApproval/ApprovalDecision 闭环、SessionStore(内存 + file)、ApprovalGate(auto-allow + 交互式)。
8. 实现 shell / web / planning 工具包与能力门控验证。
9. 实现 `task` 子 agent(上下文隔离)、SDK 门面(run/stream/resume + 缺省 port 兜底)、参考 CLI 宿主。
10. 全程满足验收:重放测试、能力门控测试、`resume` 等价性测试、SDK 最小配置(仅 model)可启动。

## 3. Non-Goals

1. **不**实现可视化 UI / 渲染层;渲染由宿主侧 `EventSink` adapter 负责。
2. **不**实现模型训练 / 微调 / 托管。
3. **不**在核心内置具体工具实现;工具是可插拔包。
4. **不**实现浏览器 / Edge runtime adapter(留作演进方向,本 Plan 仅保留扩展点)。
5. **不**实现向量记忆 / embedding 检索;首期文件记忆 + 关键字检索兜底即可。
6. **不**实现 `apply_patch`(diff)第二编辑工具;`str_replace` + fuzzy 为唯一编辑格式,diff 留扩展点。
7. **不**支持多 provider;首期仅 OpenAI 兼容 ModelPort,接口为多 provider 预留。

## 4. Key decisions

### 4.1 仓库组织:pnpm workspaces + Turborepo

**决策**:采用 pnpm monorepo,Turborepo 编排 build / test / lint / typecheck。`packages/*` 放库,`apps/*` 放宿主应用。

**理由**:架构文档 §10 的包结构(core / tools-* / provider-* / runtime-* / store-* / sdk / 宿主)天然是多包形态;只有物理分包才能真正强制"核心包零依赖"这一立身之本——把 core 单独成包后,在其 `package.json` 中 `dependencies` 为空即可被 CI 校验,而单包内部目录分层无法物理阻止 core 引入 zod / fs。Turborepo 提供增量构建与任务依赖图,适合多包并行 build/test。

**取舍**:相比单包,monorepo 初期 wiring(tsconfig project references、pnpm workspace 协议)成本更高;换来的依赖边界强制与并行构建对一个"以可移植性立身"的内核是刚需。

### 4.2 目录布局、包命名与依赖方向

**决策 1 — 目录按类目分组,scope 统一为 `@agent-core/*`**。类目目录是"一堆兄弟包的集合",一律用**复数**;`core` / `sdk` 不属任何类目,留在 `packages/` 顶层:

```
packages/
  core/                @agent-core/core            零依赖,只导出类型 + 纯函数 + port 接口   ← 永不依赖兄弟包
  sdk/                 @agent-core/sdk             依赖以下全部,拼装成门面
  tools/
    fs/                @agent-core/tools-fs
    shell/             @agent-core/tools-shell
    web/               @agent-core/tools-web
    plan/              @agent-core/tools-plan
    agent/             @agent-core/tools-agent
  providers/
    openai/            @agent-core/provider-openai
  runtimes/
    node/              @agent-core/runtime-node
  stores/
    memory/            @agent-core/store-memory
    file/             @agent-core/store-file
apps/
  reference-cli/       仅依赖 sdk,做 wiring + 订阅事件
```

**决策 2 — 命名规则:目录用复数(集合),包名前缀按"该包是什么"取单/复数**。这是刻意的语义化区分,不是疏忽:

- `tools-fs` —— 一个**装多个工具**的包,前缀复数天然正确;
- `provider-openai` / `runtime-node` / `store-memory` —— 各是**一个** provider / runtime / store,前缀单数正确。

故目录 `providers/`(复数集合)↔ 包名 `provider-openai`(单数实例)的表面不一致是**有原则的**:容器复数、实例按义。

依赖只能向下:`core ← tools-*/provider-*/runtime-*/store-* ← sdk ← apps/*`。其中 tools-* / provider-* / store-* 仅以 **type import** 消费 core 的接口类型;而 Runner(runtime-*)与 SDK 作为内核执行者,合法值导入纯函数内核(`step` / `createInitialState`)——详见 AGENTS.md「依赖单向向下」条。

**pnpm workspace glob**(混合深度):

```yaml
packages:
  - "packages/*"      # core, sdk
  - "packages/*/*"    # tools/*, providers/*, runtimes/*, stores/*
  - "apps/*"
```

**理由**:依赖倒置——core 定义接口,下游提供实现;按类目分组让未来扩展(`providers/anthropic`、`stores/postgres`、`runtimes/browser`)归属一目了然。`zod` 只允许出现在 tools-* 与 sdk;core 只认抽象的 `JSONSchema` 形态。Turborepo / tsconfig project references 按包名与 glob 工作,不关心目录嵌套,零额外成本。

**强制手段**:CI 增加一步脚本校验 `packages/core/package.json` 的 `dependencies` 与 `peerDependencies` 均为空;ESLint `no-restricted-imports` 禁止 core 内 import 任何 `@agent-core/*` 实现包与 node 内置模块。

### 4.3 核心形态:完整 reducer + effect

**决策**:`step(state, input) → { state, effects[] }` 纯函数;I/O 全在 Runner。核心内禁用隐式时间/随机/IO,一律走 `Clock` / `Random` / `Id` / `Tokenizer` port。

**理由 / 取舍**:见架构文档 §4.1。可重放性 / 可快照测试 / 可移植性是内核立身之本,值得承担更高的初期心智成本。

**强制手段**:ESLint 规则在 `packages/core/src` 禁用 `Date.now` / `Math.random` / `crypto.randomUUID` / `node:*` import;新增"重放测试"作为回归门(同输入两遍 deep-equal)。

### 4.4 首个 Provider:OpenAI 兼容 ModelPort

**决策**:首个真实 ModelPort adapter 实现为 OpenAI 兼容接口(`/v1/chat/completions`,`stream: true`,`tools` / `tool_calls`),归一化为 core 的 `ModelEvent`(text / reasoning / tool_use / usage)。`baseURL` 可配,以兼容各类 OpenAI 协议网关。

**理由**:OpenAI 兼容协议覆盖面最广(众多自建/代理网关都兼容),首期接一种、把归一化层测透,再按架构文档演进方向扩展其它 provider。

**取舍**:OpenAI 的 streaming tool_calls 是分片增量(`index` + 拼接 `arguments`),归一化层需正确累积;reasoning 字段在兼容实现中差异较大,缺失时降级为不发 reasoning 事件。

### 4.5 文件编辑格式:str_replace + fuzzy fallback

**决策**:`edit_file` 主格式 `str_replace`(`old_string` / `new_string` / `replace_all?`),精确匹配失败时 fuzzy fallback(① 忽略行首尾空白 ② 忽略 token 间空白的正则匹配);先读后改 + 版本比对门控。`apply_patch` 留扩展点不实现。

**理由 / 对比**:见架构文档 §4.3。`str_replace` + fuzzy 在直观 / token / 鲁棒性间取得最佳平衡。

### 4.6 工具 schema:Zod(仅工具层与 SDK 层)

**决策**:工具入参用 Zod 定义,运行时校验,并推导 JSON Schema 给模型。core 只认抽象 `JSONSchema`。入参非法 → 作为 `isError: true` 的 ToolResult 回喂模型自我修正,绝不抛异常中断循环。

**理由**:运行时校验强 + 单一事实源(Zod → TS 类型 + JSON Schema);见架构文档 §4.4。

### 4.7 能力门控 vs 权限策略职责分离

**决策**:**门控**(ToolRouter,纯决策)决定"工具是否对模型可见"——依据宿主注入了哪些 port;**权限**(PermissionPolicy,纯决策)决定"可见工具是否放行"——依据 `riskTier` + 配置输出 `allow` / `deny` / `ask`。两者互不重叠。

**理由**:见架构文档 §4.5 / §11,避免逻辑混乱。

## 5. 实现计划

> Phase 1–2 对应 M1,Phase 3 对应 M2,Phase 4 对应 M3,Phase 5 对应 M4,Phase 6 对应 M5,Phase 7 对应 M6,Phase 8 对应 M7。Phase 1(脚手架)是所有后续 Phase 的前置,严格串行。

### Phase 1: Monorepo 脚手架与依赖边界

**Goal**: 建立 pnpm + Turborepo monorepo 骨架,`@agent-core/core` 空包能被 build / typecheck,依赖边界由工具强制。

**Files covered**:
- `package.json`(root,`packageManager` + workspaces 脚本)
- `pnpm-workspace.yaml`
- `turbo.json`
- `tsconfig.base.json`、`tsconfig.json`(root project references)
- `.eslintrc.cjs`(含 core 禁用 `node:*` / `Date.now` / `Math.random` 规则)
- `.gitignore`
- `packages/core/package.json`(`dependencies` 为空)、`packages/core/tsconfig.json`、`packages/core/src/index.ts`(占位导出)
- `scripts/check-core-zero-deps.mjs`(CI 校验脚本)
- `vitest.config.ts` / `vitest.workspace.ts`

**Tasks**:
- [x] `git init`,创建 `.gitignore`,完成 Branch Gate(见 §"执行须知")
- [x] 初始化 pnpm workspace(`pnpm-workspace.yaml` 用混合深度 glob:`packages/*`、`packages/*/*`、`apps/*`)
- [x] 配置 Turborepo `turbo.json`:定义 `build` / `test` / `lint` / `typecheck` 任务及其 `dependsOn` 拓扑
- [x] 配置 `tsconfig.base.json` + project references,启用 `strict` / `noUncheckedIndexedAccess`
- [x] 配置 ESLint:`packages/core/**` 通过 `no-restricted-imports` 禁用 `node:*` 与所有 `@agent-core/*` 实现包,禁用 `Date.now` / `Math.random` / `crypto.randomUUID`
- [x] 创建 `@agent-core/core` 空包(仅占位 `index.ts`),`dependencies` 字段为空
- [x] 编写 `scripts/check-core-zero-deps.mjs`:断言 core 包 `dependencies`/`peerDependencies` 为空,接入 `turbo run lint`
- [x] 配置 Vitest workspace,跑通一个 smoke 测试

**Acceptance Criteria**:
1. `pnpm install && pnpm turbo run build typecheck lint test` 全部通过。
2. 故意在 `packages/core/src` 内 import `node:fs` 或调用 `Date.now()`,`pnpm turbo run lint` 报错。
3. 故意给 `packages/core/package.json` 添加一个 dependency,`check-core-zero-deps` 脚本报错(退出码非 0)。

**Reviewed**: 2026-06-03 by reviewer
**Commit**: 249a1a6 feat(plan-001): phase 1 - monorepo 脚手架与依赖边界

---

### Phase 2: 纯内核状态机(类型 + step reducer + ports 接口)

**Goal**: 实现 `AgentState` / `AgentInput` / `Effect` 类型、全部 port 接口、`step()` reducer,用内联模拟数据跑通完整 inner-loop,并通过重放测试。

**Files covered**:
- `packages/core/src/state.ts`(`AgentState`)
- `packages/core/src/input.ts`(`AgentInput` 联合类型)
- `packages/core/src/effect.ts`(`Effect` 联合类型)
- `packages/core/src/reducer.ts`(`step()`)
- `packages/core/src/ports.ts`(`ModelPort` / `FileSystem` / `Shell` / `Network` / `SessionStore` / `EventSink` / `ApprovalGate` / `Clock` / `Id` / `Random` / `Tokenizer`,仅类型)
- `packages/core/src/tool.ts`(`ToolDefinition` / `ToolResult` / `Capability` / `riskTier` 类型 + 抽象 `JSONSchema`)
- `packages/core/src/index.ts`(统一导出)
- `packages/core/src/__tests__/reducer.test.ts`、`replay.test.ts`

**Tasks**:
- [x] 定义 `AgentState`:`{ messages[], pendingTools[], status, tokenBudget, turnCount, readFiles }`,全部纯可序列化
- [x] 定义 `AgentInput` 联合:`UserMessage` / `ModelChunk` / `ModelDone` / `ModelError` / `ToolResult` / `ApprovalDecision` / `Cancel`
- [x] 定义 `Effect` 联合:`CallModel` / `ExecuteTool` / `RequestApproval` / `Emit` / `Checkpoint` / `WaitForInput` / `Done`
- [x] 定义全部 port 接口(仅类型)与 `ToolDefinition` / `ToolResult` / `Capability` / `JSONSchema`
- [x] 实现 `step()`:处理 status 转移(idle → calling_model → executing_tools → … → done),由 stop reason 驱动终止(`tool_use` 继续,`end_turn`/纯文本结束,`max_tokens` 决定续写/报错)
- [x] 实现 turn 级 token 预算 + 最大迭代数强制(防失控)
- [x] 单测:user → CallModel → tool_use → ExecuteTool → ToolResult → CallModel → Done 全链路
- [x] 重放测试:相同 input 序列两次运行,(state, effects) 序列 deep-equal

**Acceptance Criteria**:
1. 单测覆盖 user → CallModel → tool_use → ExecuteTool → ToolResult → CallModel → Done 全链路并通过。
2. reducer 内无隐式副作用(由 Phase 1 的 lint 规则保证 + code review)。
3. 重放测试:相同输入序列两次运行结果完全一致(deep-equal)。
4. `core` 包仍零运行时依赖。

**Reviewed**: 2026-06-03 by reviewer
**Commit**: abd0892 feat(plan-001): phase 2 - 纯内核状态机

---

### Phase 3: Runner 与 OpenAI 兼容 ModelPort(M2)

**Goal**: 实现薄 Runner(effect 解释器),接入 OpenAI 兼容 ModelPort 流式归一化,提供 mock ModelPort,跑通含取消路径的端到端循环。

**Files covered**:
- `packages/runtimes/node/src/runner.ts`(effect 解释器)
- `packages/runtimes/node/src/index.ts`
- `packages/providers/openai/src/model-port.ts`(`stream(req)` 归一化)
- `packages/providers/openai/src/stream-normalize.ts`(SSE → `ModelEvent`)
- `packages/providers/openai/src/index.ts`
- `packages/core/src/testing/mock-model-port.ts`(mock,供测试与下游复用)
- 对应 `__tests__/`

**Tasks**:
- [x] 实现 Runner:循环 `step` → 对每个 effect 调对应 port → 结果作为 input 回喂,直到 `Done`
- [x] Runner 支持 `CallModel`(消费 `ModelPort.stream` 的 chunk 回喂)、`Emit`、`Checkpoint`、`WaitForInput`
- [x] Runner 接入 `AbortSignal`:收到 `Cancel` input → reducer 转 `cancelling` → Runner 对进行中的 model stream / tool 触发 abort
- [x] 实现 mock ModelPort:按脚本产出 text / tool_use / usage 事件,供确定性测试
- [x] 实现 OpenAI 兼容 ModelPort:`/v1/chat/completions` `stream:true`,`baseURL` 可配
- [x] 实现流式归一化:累积分片 `tool_calls`(按 `index` 拼接 `arguments`)、text delta、usage;reasoning 缺失时降级
- [x] 单测:Runner + mock 跑通含取消路径的端到端循环;归一化单测覆盖分片 tool_call 拼接

**Acceptance Criteria**:
1. Runner 用 mock 跑通含取消路径的端到端循环。
2. 接真实 OpenAI 兼容 provider 能完成一轮流式对话,usage 正确归一化(集成测试可标记为按需运行/需要 API key)。
3. `Cancel` 能中止进行中的 stream(AbortSignal 生效),pending 被清理。

**Reviewed**: 2026-06-03 by reviewer
**Commit**: b8009b8 feat(plan-001): phase 3 - Runner 与 OpenAI 兼容 ModelPort

---

### Phase 4: ToolRouter、文件工具包与 Node 文件 adapter(M3)

**Goal**: 实现 ToolRouter(Zod 校验 + 能力门控)、文件工具包、Node 文件 adapter(工作区边界),`edit_file` 完成 str_replace + fuzzy + 先读后改 + 版本比对。

**Files covered**:
- `packages/core/src/tool-router.ts`(纯决策:校验入参、能力门控、生成 `ExecuteTool`)
- `packages/tools/fs/src/{read-file,edit-file,write-file,ls,glob,grep}.ts`
- `packages/tools/fs/src/fuzzy-match.ts`(fuzzy fallback 算法)
- `packages/tools/fs/src/index.ts`
- `packages/runtimes/node/src/filesystem.ts`(Node FileSystem adapter,含沙箱边界 resolve)
- 对应 `__tests__/`

**Tasks**:
- [x] 实现 ToolRouter:对每个 tool_use 用工具的 JSONSchema 校验入参;能力门控——`requires` 未被宿主满足的工具从可见集摘除;非法入参 → `isError` ToolResult 回喂
- [x] 实现 Node `FileSystem` adapter:`read`/`write`/`stat`/`list`/`glob`/`grep`,路径 resolve 后校验在工作区内,越界返回错误
- [x] 实现 `read_file`:带行号(`cat -n` 风格)、`offset`/`limit` 分页、上限截断(声明截断)、记录"已读文件 + 版本"到 state
- [x] 实现 `edit_file`:str_replace 主格式;0 次/多次匹配返回明确错误结果;fuzzy fallback(忽略行首尾空白 → 忽略 token 间空白正则);先读后改门控;写回前版本比对
- [x] 实现 `write_file`:新建(`WRITE_LOW`)/ 覆盖(`WRITE_HIGH`)区分;覆盖前要求先 read
- [x] 实现 `ls` / `glob`(按修改时间排序)/ `grep`(底层 ripgrep,输出模式 + 截断告知)
- [x] ToolResult 双层:`modelContent` + `displayMetadata`(diff/行数/耗时)
- [x] 端到端测试:读文件 → 改文件

**Acceptance Criteria**:
1. `edit_file` 精确匹配失败时 fuzzy fallback 能正确命中并以原文实际内容替换。
2. `edit_file` 对 0 次 / 多次匹配返回明确错误结果(非异常)。
3. 未 `read_file`(或版本过期)的文件 `edit_file` 被拒绝。
4. 端到端跑通"读文件 → 改文件";越界路径被 FileSystem adapter 拒绝。

**Reviewed**: 2026-06-03 by reviewer
**Commit**: 9c0065b feat(plan-001): phase 4 - ToolRouter, FS tools and Node filesystem adapter
**Review 跟进**: 读改门控改为纯状态驱动(`state.readFiles` + `file-gate.ts`,写盘前裁决,survives resume)、工具入参改用 Zod、grep 改用 ripgrep、修复工作区边界前缀绕过、glob/ls 按 mtime 排序、去重 ToolRouter。

---

### Phase 5: 上下文工程 —— ContextAssembler / Tokenizer / Compactor(M4)

**Goal**: 实现 cache 友好的 ContextAssembler、Tokenizer adapter、Compactor 压缩决策。

**Files covered**:
- `packages/core/src/context-assembler.ts`(纯函数)
- `packages/core/src/compactor.ts`(纯函数,压缩决策)
- `packages/runtimes/node/src/tokenizer.ts`(char-heuristic 实现)
- `packages/core/src/testing/char-tokenizer.ts`(确定性 tokenizer 供测试)
- 对应 `__tests__/`

**Tasks**:
- [x] 实现 ContextAssembler:把 system prompt / tool defs / 项目指令(静态)前置,user 输入 / tool result(变量)后置,保证可缓存前缀稳定
- [x] 实现 Tokenizer adapter(char-heuristic)与确定性测试版
- [x] 实现 Compactor:依 Tokenizer 估算判断是否压缩、压缩哪些消息;保留近因 + 关键决策 / 文件路径 / 未完成 todo;实际摘要走 `CallModel` 效果(调便宜模型)
- [x] 测试:超长 history 触发 Compactor 并保留关键信息;工具集不变时静态前缀稳定

**Acceptance Criteria**:
1. 超长 history 时 Compactor 正确触发并保留关键信息(近因 / 文件路径 / 未完成 todo)。✅
2. 工具集不变时 ContextAssembler 产出的静态前缀稳定(逐字节可缓存)。✅

**Review 跟进**:首轮 review FAIL —— `extractFilePaths` / `hasIncompleteTodos` 仅作为 helper 存在,从未接入 `decideCompaction` 决策路径,带文件路径 / 未完成 todo 的非近因消息会被误压缩(违反 AC1);且 AC1 测试为空断言(只校验 summary prompt 常量字符串)。返工:新增 `isKeyMessage` 并在压缩筛选前排除关键消息使其留在 `preservedMessages`;补真实保留测试(断言 `preservedMessages` / `compressibleMessages` 成员)、AC2 字节对比测试、修复路径正则对前置标点的漏匹配。复审 PASS。
**遗留(留待 Phase 6 Runner 接线注意)**:`compactRange` 由压缩消息的 min/max index 派生,当被压缩消息因关键消息插入而非连续时,该 range 会跨越保留的关键消息 —— 消费方须以 `compressibleMessages` 成员为准,勿将 `compactRange` 当作可整段删除的连续区间。

**Reviewed**: 2026-06-04 by reviewer (code-reviewer subagent)
**Commit**: 855b241 feat(plan-001): phase 5 - ContextAssembler / Tokenizer / Compactor(review 跟进见下一 fix commit)

---

### Phase 6: 权限、HITL 与会话恢复(M5)

**Goal**: 实现 PermissionPolicy、RequestApproval/ApprovalDecision 闭环、SessionStore(内存 + file)、ApprovalGate(auto-allow + 交互式)。

**Files covered**:
- `packages/core/src/permission-policy.ts`(纯决策)
- `packages/stores/memory/src/index.ts`
- `packages/stores/file/src/index.ts`
- `packages/runtimes/node/src/approval-gate.ts`(auto-allow + 终端交互)
- `packages/core/src/testing/store-contract.ts`(共享行为测试套件)
- 对应 `__tests__/`

**Tasks**:
- [x] 实现 PermissionPolicy:依 `riskTier` + 配置输出 `allow` / `deny` / `ask`
- [x] reducer/Runner 支持 `RequestApproval` 效果 → `ApprovalGate.ask` → `ApprovalDecision` 回喂;`ask` 时落 `Checkpoint` 暂停
- [x] 实现内存 SessionStore 与 file SessionStore:`save` / `load` / `list`(`@agent-core/store-file` 为 file-based JSON 持久化,已通过合同测试)
- [x] 抽取 SessionStore 共享行为测试套件,两种实现都跑通
- [x] 实现 SDK 层 `resume(sessionId, decision)` 的核心支撑(从 checkpoint 重建 state 续跑)—— SDK 门面在 Phase 8 组装
- [x] 实现 ApprovalGate:auto-allow(策略自动)+ 终端交互式
- [x] 测试:写/高风险工具触发 `ask` → 中断落盘 → resume 续跑等价

**Acceptance Criteria**:
1. 写 / 高风险工具触发 `ask`,中断后状态完整落盘(snapshot 可序列化)。
2. 从 checkpoint 重建续跑(`resume(sessionId, decision)`)结果与不中断等价。
3. 内存 store 与 file store 通过同一组行为测试。✅

**Review 跟进**:首轮 review FAIL —— Runner 的 HITL `ask` 闭环断裂:`interpretEffects` 同步取得审批并回喂 `approval_decision` 后,reducer 产出的 `execute_tool` / `call_model` 效果被 `forwardEmit` 丢弃,且 runLoop 直接 `return`,导致**已批准的工具永不执行、deny 后模型永不重调**(实证探针 `executed=0, status=executing_tools`);`resume` 在配 `permissionConfig` 时会对已批准工具重跑权限检查 → 无限重暂停;且全无 Runner 级 ask/checkpoint/resume 测试。返工:① `ask` 分支改 `break` 让外层 while 按新状态重新分发以闭环;② 新增 `approvedToolCallIds`,审批通过的工具 id 绕过权限门(`interpretEffects` 与 `resume` 两处填充);③ `interpretEffects` 先持久化 checkpoint 再询问 gate(防 gate 抛错/延迟丢快照);④ 新增 `runner-hitl.test.ts` 4 例(auto-allow 执行闭环 / deny 重调模型 / 暂停落 checkpoint / resume 与不中断等价)。复审 PASS。

**Reviewed**: 2026-06-04 by reviewer (code-reviewer subagent)
**Commit**: 6cab9c8 feat(plan-001): phase 6 - 权限策略 / HITL 审批闭环 / SessionStore / resume(返工后复审 PASS;另:已批准 id 在工具执行后即从 `approvedToolCallIds` 移除,杜绝跨调用绕过 + 防 Set 无界增长)

---

### Phase 7: Shell / Web / Planning 工具与能力门控验证(M6)

**Goal**: 实现 `bash`(经 Shell port)、`web_fetch`/`web_search`(经 Network port)、`write_todos`,并验证能力门控。

**Files covered**:
- `packages/tools/shell/src/bash.ts`、`index.ts`
- `packages/tools/web/src/{web-fetch,web-search}.ts`、`index.ts`
- `packages/tools/plan/src/write-todos.ts`、`index.ts`
- `packages/runtimes/node/src/{shell,network}.ts`(Shell / Network adapter)
- 对应 `__tests__/`(含能力门控集成测试)

**Tasks**:
- [x] 实现 Node `Shell` adapter:子进程执行,流式 stdout/stderr/exit,`timeout` / `run_in_background` / 工作目录约束
- [x] 实现 `bash` 工具:输出截断并声明;高风险命令(删除/推送/网络/提权)经 PermissionPolicy 必 `ask`
- [x] 实现 Node `Network` adapter 与 `web_fetch` / `web_search`
- [x] 实现 `write_todos`(纯状态操作),发 `todoListUpdated` 事件
- [x] 能力门控集成测试:未注入 Shell port 时可见工具集不含 `bash`

**Acceptance Criteria**:
1. 未注入 Shell port 时可见工具集不含 `bash`,模型无法调用(门控测试通过)。✅
2. `bash` 高风险命令触发 `ask`;输出流式回传且超量截断并声明。✅

**Reviewed**: 2026-06-04 by reviewer (code-reviewer subagent, 2nd pass)
**Commit**: 6f597f6 fix(plan-001): phase 7 review 跟进 — P0/P1/P2 全量返工
**Review 跟进**: 首轮 review 发现 6 项需返工：(1) Shell 串行读流死锁 → 改用事件监听并行消费 stdout/stderr（async queue + Promise resolver chain）；(2) Shell/Network tool executor 无 e2e 闭环测试 → 新增 shell-e2e + network-e2e + bash-ask-e2e 三组测试；(3) 工具类目互相依赖错位 → 提取 `@agent-core/tools-common`（`defineTool` / `Tool` 通用工厂），fs/shell/web/plan 均依赖 common 而非 fs；(4) `write_todos` 绕过 effect channel 直接调 EventSink → 改为 `displayMetadata.pendingEvents`，Runner 统一转发；(5) Network port 缺 `abortSignal` → `NetworkRequest` 增 `abortSignal?`，Node adapter + Runner ToolExecutorContext + web 工具全链路贯通；(6) network adapter test 用 `Map` 冒充 `Headers` → 改用 `new Headers()`。P2: bash riskTier 保持 `WRITE_HIGH`（首期所有 bash 一律 ask，依赖宿主 `toolOverrides` 细分），`write_todos` 保持 `WRITE_LOW`（工具更新内存状态）。复审 PASS。

---

### Phase 8: 子 Agent、SDK 门面与参考 CLI 宿主(M7)

**Goal**: 实现 `task` 子 agent(上下文隔离)、SDK 门面(run/stream/resume + 缺省 port 兜底)、参考 CLI 宿主。

**Files covered**:
- `packages/tools/agent/src/task.ts`、`index.ts`
- `packages/sdk/src/create-agent.ts`(`run` / `stream` / `resume`)
- `packages/sdk/src/defaults.ts`(缺省 port:内存 store / no-op EventSink / real Clock|Id|Random)
- `packages/sdk/src/index.ts`
- `apps/reference-cli/src/main.ts`、`apps/reference-cli/package.json`
- 对应 `__tests__/`

**Tasks**:
- [x] 实现 `task` 子 agent:新建核心实例(独立 context window + 工具集,共享 ModelPort / 工具注册表),最终输出作为一条 tool_result 返回主循环(上下文隔离)
- [x] 实现 SDK `createAgent({ model, tools, store, approval, fs, shell, ... })`:缺省 port 用内存 / no-op / real 时间随机兜底
- [x] 实现 `run(input)`(跑完一个 turn 返回最终消息)、`stream(input)`(实时 event 迭代)、`resume(sessionId, decision)`
- [x] 实现参考 CLI:wiring(选 adapter + 注入能力 + 订阅事件 + stdout 渲染),核心包零改动
- [x] 测试:参考宿主仅 wiring 跑通完整流程;`task` 子 agent 上下文隔离;SDK 最小配置(仅 model)启动纯对话 agent

**Acceptance Criteria**:
1. 参考宿主仅通过 wiring(选 adapter)跑通完整流程,`@agent-core/core` 包零改动(git diff 在本 Phase 不含 core 包)。✅
2. `task` 子 agent 上下文隔离,主 agent 仅收到其最终输出。✅
3. SDK 最小配置(仅 `model`)可启动一个纯对话 agent 并完成一轮对话。✅

**Reviewed**: 2026-06-04 by reviewer (code-reviewer subagent)
**Commit**: 7331347 feat(plan-001): phase 8 - 子 Agent / SDK 门面 / 参考 CLI 宿主
**Review 跟进**: 独立复审发现 2 项 P1 + 4 项 P2 + 5 项 P3 需返工：
- **P1** (已修复)：① Runner Compactor/ContextAssembler/Tokenizer 接线 — Runner 新增 `compaction?: CompactionConfig` 入参，`runModelStream()` 每次调模型前跑 `decideCompaction`，超阈值时先发 summarization call 再替换 compressible messages；SDK 通过 `compaction` 选项透传（默认不开启，传入即生效，默认 tokenizer 为 char-heuristic）。② SDK 三个死配置修复 — `systemPrompt` 注入为首轮 system message 并跨 turn 保持；`maxIterations` / `tokenBudget` 透传至 `createInitialState`；移除 `cwd` 装饰性选项。
- **P2** (已修复)：① `resume()` 跨进程 — 先尝试 `lastRunner.resume()`，失败后从 `sessionStore.load()` 重建 Runner 续跑；② 子 agent `eventSink` 透传 — sub-runner 接收 `opts.eventSink`；③ 工具名路由去硬编码 — `FS_TOOL_NAMES` / `SHELL_TOOL_NAMES` / `NETWORK_TOOL_NAMES` 从各包导出 `ReadonlySet<string>`，SDK 用 `.has()` 分发。
- **P3** (已修复)：`createInitialState` 传 `messages: undefined` 覆盖默认 `[]` 的 bug — 改为条件性 spread，仅在有值时传入。
**Review 跟进 Commit**: 36f9a8b fix(plan-001): phase 8 review 跟进 — P1/P2/P3 全量返工

**二次 Review 跟进** (2026-06-04 复审)：上一轮声称已修复但实际未生效 / 新引入回归 / 测试缺位的项，本轮全量补齐：
- **P0** (已修复)：① `stream()` 早退错误丢失 — 之前的 `yield* … await runPromise; throw runError` 在 consumer `break` 时不会执行，验证脚本确认错误被吞；改为 `AbortController + try/finally` 模式：在 `finally` 中 `abortController.abort()` 并 `await runPromise`，保证 runner 被取消、错误被透出；新增 `stream-early-break.test.ts` 2 例回归覆盖。② Runner compaction summary 位置错误 — 之前 `[...preservedMessages, summary]` 把摘要放到最末，模型会读作"最新一句用户输入"；改为 `[...system, summary(role=system), ...non-system preserved]`，并把 summary 的 role 从 `user` 升级为 `system`；新增 `runner-compaction.test.ts` 2 例（spy ModelPort 验证 summary 位置 + 阈值未触发时不压缩）。
- **P1** (已修复)：③ 子 agent 事件无来源标签导致 CLI 输出混杂 — 新增 `tagEventSink(inner, depth, label)` wrapper，sub-runner 用包装过的 sink 把 `agentDepth` / `agentLabel` 注入事件 payload；reference-CLI 的 `createRenderingEventSink` 据此对 sub-agent 输出加 `[task (depth=1)]…[/depth=1]` 包裹。④ SDK 直接捏 reducer 内部累加字段 (`_accumulatedText` / `_accumulatedToolCalls`) — 在 core 新增导出纯函数 `resetTurnForNextInput(state)`，SDK 改调它，不再触碰内部字段；core 重构这些字段时 SDK 不会再静默坏。
- **P2 测试补齐**：⑤ sub-agent messages 隔离 — `sub-agent-messages-isolation.test.ts` 用 spy ModelPort 断言第 2 次调用（sub-agent）的 `messages` 长度为 1 且不含父对话，第 3 次（主回流）含 tool_result；附加一例断言 sub 事件携带 `agentDepth >= 1`、main 事件不带。⑥ 参考 CLI smoke — `apps/reference-cli` 启用 vitest，新增 `render.test.ts`（2 例：主输出 / sub 包裹）与 `smoke.test.ts`（mock ModelPort + renderer 端到端）。⑦ SDK resume 正向闭环 — `resume.test.ts` 3 例覆盖：同进程 HITL ask → checkpoint → resume(`allow`) → 工具执行 + 续跑；resume 不存在 sessionId 报错；跨进程（新 agent 实例共享 store）resume 续跑等价。
- **配套改动**：SDK `CreateAgentOptions` 新增 `approvalGate?: ApprovalGate` 选项（之前 hardcode `createAutoAllowGate()`，无法测 HITL 闭环）。
**二次 Review 跟进 Commit**: f5635ff fix(plan-001): phase 8 二次 review 跟进 — P0/P1/P2 全量修复 + 补测

---

## 9. 遗留修复项（全量 Review 后续）

> 2026-06-04 全量 code review 发现但未在本轮修复的问题。按影响面排序，留待后续迭代处理。

### 9.1 P2 — 需要修复但影响面可控

| # | 模块 | 问题描述 | 修复方案 | 阻塞原因 |
|---|------|---------|---------|---------|
| D-1 | `packages/tools/fs/src/glob.ts` | `glob` 输出无截断声明：`**/*` 在大仓库返回数千路径无 limit | 新增 `limit` 参数（默认 500），超量截断 + truncation declaration | 需评估默认值对不同仓库的适用性 |
| D-2 | `packages/tools/fs/src/grep.ts` | grep 截断了 match 数但未限止单行长度：200KB 单行仍会爆炸 | 每条 match 文本限长（如 2000 字符）+ `[truncated]` 后缀 | 需与 bash 工具的截断策略对齐 |
| D-3 | `packages/runtimes/node/src/approval-gate.ts` | Interactive gate 无 AbortSignal 支持：agent 取消后 readline 接口泄漏 | `createInteractiveGate()` 接受 `AbortSignal`，abort 时 `rl.close()` | 需改 API 签名，影响面较大 |
| D-4 | `packages/runtimes/node/src/runner.ts:425` | checkpoint 用 `Date.now()`，破坏 runner 级重放确定性 | RunnerOptions 新增 `clock?: Clock` 可选注入 | 架构允许但影响测试确定性 |
| D-5 | `packages/providers/openai/src/stream-normalize.ts:47-128` | 无 usage chunk 时 token 计数归零：流以 choices 结束但无 usage chunk → `lastUsage` 为 undefined → synthesized `model_done` 不带 usage | stream-normalize 在 generator 结束时 yield 一个零值 usage event 作为兜底 | 边缘场景，实际 OpenAI 始终返回 usage |

### 9.2 P2 — 测试覆盖度缺口

| # | 模块 | 缺口描述 | 补测方案 |
|---|------|---------|---------|
| T-1 | `packages/core/src/tool-router.ts` | `validateToolInput`、`filterVisibleTools`、`routeToolCall` 三个纯函数零单元测试 | 新增 `tool-router.test.ts`：必填字段校验、类型强转、schema 缺 properties、空 capabilities、未知工具 |
| T-2 | `packages/core/src/file-gate.ts` | `recordFileAccess`、`evaluateEditGate`、`evaluateOverwriteGate` 等纯决策函数零单元测试 | 新增 `file-gate.test.ts`：版本 bump、mtime 匹配/不匹配、新文件/已存在文件、extractFileAccess 解析 |
| T-3 | `packages/tools/fs/src/ls.ts` | `createLsTool` handler 零测试 | 新增测试：正常目录列表、空目录返回 "(empty)"、不存在路径返回 isError |
| T-4 | `packages/tools/fs/src/glob.ts` | `createGlobTool` handler 零测试 | 新增测试：pattern 匹配、无匹配返回空、输出截断声明 |
| T-5 | `packages/tools/fs/src/grep.ts` | `createGrepTool` handler 零测试 | 新增测试：正常搜索、无匹配、limit 截断、单行超长截断 |
| T-6 | `packages/tools/fs/src/write-file.ts` | `createWriteFileTool` handler 零测试（仅门控被间接测试） | 新增测试：新建文件、覆盖文件、Zod 校验失败、fs.write 抛错、displayMetadata 形状 |
| T-7 | `packages/sdk/src/stream-channel.ts` | producer-consumer 桥接无独立测试 | 新增 `stream-channel.test.ts`：多次 emit before poll、done while awaiting、队列背压 |
| T-8 | `packages/tools/fs/` | FS 能力门控测试缺失（shell/web/plan 均有 `capability-gating.test.ts`，fs 缺失） | 新增 `capability-gating.test.ts`：未注入 FileSystem port 时 `read_file`/`edit_file`/`write_file` 不可见 |
| T-9 | `packages/runtimes/node/src/tokenizer.ts` | `createNodeTokenizer` 无测试 | 新增测试：空字符串返回 0、正常文本返回 `Math.max(1, ceil(len/4))` |
| T-10 | `packages/core/src/compactor.ts` | `summaryPrompt` 空 compressible 边界未测 | 新增测试：compressible 为空时 `summaryPrompt` 不崩溃（或 `shouldCompact` 不触发） |

### 9.3 P3 — 低优先级改进

| # | 模块 | 描述 |
|---|------|------|
| N-1 | `packages/runtimes/node/src/shell.ts:88` | 信号终止时 exit code 默认 1，非常规 128+signum（如 SIGTERM=143） |
| N-2 | `packages/runtimes/node/src/shell.ts:56-58` | SIGKILL timer 未存储引用、未在 finally 中 clearTimeout，进程提前退出时 timer 泄漏 |
| N-3 | `packages/runtimes/node/src/tokenizer.ts:15` | `charsPerToken=4` 对英文偏移，CJK 文本（约 1.5-2 chars/token）会 2x 延迟触发 compaction |
| N-4 | `packages/core/src/reducer.ts:559` | `buildAssistantContent` JSON parse 失败静默吞掉，丢失原始文本上下文 |
| N-5 | `packages/providers/openai/src/model-port.ts:172` | SSE parser 不处理多行 `data:` 字段（罕见但不符合 SSE 规范） |
| N-6 | `apps/reference-cli/src/render.ts:34` | Sub-agent 以 depth>0 事件结束时 `[depth=N]` 标签不关闭 |
| N-7 | `packages/stores/file/src/index.ts:59` | `list()` 静默吞掉 JSON parse 错误，损坏数据不可见 |
| N-8 | `packages/core/src/compactor.ts:66` | 路径 regex 贪婪匹配，会误捕 CSS selector（`/deep/`）、URL 等 |
| N-9 | `packages/runtimes/node/src/shell-adapter.test.ts:38` | 用 `Date.now()` 断言耗时，慢 CI 上不稳定 |

---

## 6. Risks and mitigations

| Risk | Impact | Mitigation |
|---|---|---|
| reducer+effect 写法心智成本高 | 开发放缓、早期 bug | Phase 2 先用 mock 把状态机测透;严格 review reducer 纯度;重放测试作回归门 |
| `str_replace` 即便有 fuzzy 仍可能匹配失败 | 编辑工具可用性下降 | 失败时返回"附近候选 + 明确提示"让模型自我修正;监控失败率,必要时引入 `apply_patch` |
| 无意引入隐式副作用(时间/随机) | 破坏可重放性 | ESLint 禁用相关 API(Phase 1)+ review + 重放测试 |
| OpenAI 兼容各网关差异(reasoning / 分片 tool_calls) | 流式 / usage / tool_use 解析错乱 | mock + 真实双轨测试;reasoning 缺失降级;归一化层专测分片拼接 |
| 能力门控与权限策略职责重叠 | 逻辑混乱 | 明确分工:门控=可见性(ToolRouter),权限=放行(PermissionPolicy) |
| 核心包被无意引入依赖 | 破坏"零依赖"立身之本 | `check-core-zero-deps` CI 脚本 + ESLint `no-restricted-imports`(Phase 1) |
| monorepo wiring(project references / turbo 图)成本 | 初期搭建慢 | Phase 1 集中处理,后续 Phase 仅加包不动骨架 |

---

## 执行须知(Branch Gate)

本仓库当前**非 git 仓库**。Phase 1 首个任务即:`git init` → 创建 `.gitignore` → 建立主分支(`main`)→ 从 `main` 切出 feature 分支 `feat/plan-001-pure-agent-core`,所有 Phase 提交落在该分支。每个 Phase 完成后须经独立 review pass 通过,再做单独提交,方可进入下一 Phase。

---

## Test Cases

### TC-1: Monorepo 构建通过（Phase 1 AC1）

**Title**: 全量 build / typecheck / lint / test 通过  
**Preconditions**: 已 `pnpm install`  
**Steps**:
1. 运行 `pnpm turbo run build typecheck lint test`
2. 检查退出码为 0  
**Paths involved**: `turbo.json`、所有 `package.json`  
**Expected result**: 全部任务成功，无错误输出

### TC-2: 核心包 lint 规则阻止 I/O（Phase 1 AC2）

**Title**: ESLint 禁止 core 内 `node:fs` import 与 `Date.now()` 调用  
**Preconditions**: 项目构建环境正常  
**Steps**:
1. 在 `packages/core/src` 任意 `.ts` 文件中添加 `import fs from "node:fs"`
2. 运行 `pnpm turbo run lint --filter @agent-core/core`
3. 观察 lint 报错（`no-restricted-imports`）  
**Paths involved**: `packages/core/src/*.ts`  
**Expected result**: lint 报错，退出码非 0

### TC-3: 核心包零依赖校验（Phase 1 AC3）

**Title**: `check-core-zero-deps` 脚本拒绝非空 dependencies  
**Preconditions**: 项目构建环境正常  
**Steps**:
1. 临时给 `packages/core/package.json` 的 `dependencies` 添加 `"foo": "1.0.0"`
2. 运行 `node scripts/check-core-zero-deps.mjs`
3. 观察退出码非 0  
**Paths involved**: `packages/core/package.json`、`scripts/check-core-zero-deps.mjs`  
**Expected result**: 脚本报错并以非 0 退出码退出

### TC-4: Reducer 全链路单测（Phase 2 AC1）

**Title**: user → CallModel → tool_use → ExecuteTool → ToolResult → CallModel → Done  
**Preconditions**: 项目构建环境正常  
**Steps**:
1. 运行 `pnpm turbo run test --filter @agent-core/core`
2. 观察 `reducer.test.ts` 中 "full tool use loop" 用例通过  
**Paths involved**: `packages/core/src/__tests__/reducer.test.ts`  
**Expected result**: 单测通过，消息序列为 user → assistant(tool_use) → tool → assistant(text)

### TC-5: 重放测试确定性（Phase 2 AC3）

**Title**: 相同 input 序列两次运行产生 deep-equal (state, effects) 序列  
**Preconditions**: 项目构建环境正常  
**Steps**:
1. 运行 `pnpm turbo run test --filter @agent-core/core`
2. 观察 `replay.test.ts` 用例通过  
**Paths involved**: `packages/core/src/__tests__/replay.test.ts`  
**Expected result**: 两次运行的 state 和 effects 序列完全一致

### TC-6: Runner 取消路径（Phase 3 AC3）

**Title**: AbortSignal 中止进行中的 stream  
**Preconditions**: 项目构建环境正常  
**Steps**:
1. 运行 `pnpm turbo run test --filter @agent-core/runtime-node`
2. 观察 `runner.test.ts` 中 cancellation 相关用例通过  
**Paths involved**: `packages/runtimes/node/src/__tests__/runner.test.ts`  
**Expected result**: Runner 在 AbortSignal 触发后进入 done 状态，pending 被清理

### TC-7: edit_file fuzzy fallback（Phase 4 AC1）

**Title**: 精确匹配失败时 fuzzy fallback 正确命中  
**Preconditions**: Node FileSystem adapter 可用  
**Steps**:
1. 运行 `pnpm turbo run test --filter @agent-core/tools-fs`
2. 观察 `tools.test.ts` 中 fuzzy match 相关用例通过  
**Paths involved**: `packages/tools/fs/src/__tests__/tools.test.ts`、`packages/tools/fs/src/fuzzy-match.ts`  
**Expected result**: fuzzy fallback 正确替换目标内容

### TC-8: edit_file 读改门控（Phase 4 AC3）

**Title**: 未 read_file 的文件被 edit_file 拒绝  
**Preconditions**: Node FileSystem adapter 可用  
**Steps**:
1. 运行 `pnpm turbo run test --filter @agent-core/tools-fs`
2. 观察 edit_file 未读拒绝用例通过  
**Paths involved**: `packages/tools/fs/src/__tests__/tools.test.ts`  
**Expected result**: 返回 `isError: true` 的 ToolResult，模型可自我修正

### TC-9: Compactor 关键信息保留（Phase 5 AC1）

**Title**: 超长 history 触发 Compactor 并保留近因/文件路径/未完成 todo  
**Preconditions**: 项目构建环境正常  
**Steps**:
1. 运行 `pnpm turbo run test --filter @agent-core/core`
2. 观察 `compactor.test.ts` 中 "preserves key messages" 用例通过  
**Paths involved**: `packages/core/src/__tests__/compactor.test.ts`  
**Expected result**: `preservedMessages` 包含关键消息，`compressibleMessages` 不含

### TC-10: HITL 审批闭环（Phase 6 AC1+AC2）

**Title**: ask → 中断落盘 → resume 续跑等价  
**Preconditions**: 项目构建环境正常  
**Steps**:
1. 运行 `pnpm turbo run test --filter @agent-core/runtime-node`
2. 观察 `runner-hitl.test.ts` 中 "resume equivalence" 用例通过  
**Paths involved**: `packages/runtimes/node/src/__tests__/runner-hitl.test.ts`  
**Expected result**: resume 后的 final state 与不中断路径的 final state 等价

### TC-11: SessionStore 合同测试（Phase 6 AC3）

**Title**: 内存 store 与 file store 通过同一组行为测试  
**Preconditions**: 项目构建环境正常  
**Steps**:
1. 运行 `pnpm turbo run test --filter @agent-core/store-memory --filter @agent-core/store-file`
2. 观察合同测试用例通过  
**Paths involved**: `packages/core/src/testing/store-contract.ts`、`packages/stores/memory/src/__tests__/`、`packages/stores/file/src/__tests__/`  
**Expected result**: 两种 store 实现均通过 save / load / list 行为测试

### TC-12: Shell 能力门控（Phase 7 AC1）

**Title**: 未注入 Shell port 时 bash 工具不可见  
**Preconditions**: 项目构建环境正常  
**Steps**:
1. 运行 `pnpm turbo run test --filter @agent-core/tools-web`
2. 观察 `capability-gating.test.ts` 用例通过  
**Paths involved**: `packages/tools/web/src/__tests__/capability-gating.test.ts`  
**Expected result**: `filterVisibleTools` 在缺少对应 capability 时摘除工具

### TC-13: 参考宿主纯 wiring（Phase 8 AC1）

**Title**: 参考 CLI 仅通过 wiring 跑通完整流程，core 包零改动  
**Preconditions**: Phase 8 已提交  
**Steps**:
1. 运行 `git diff --stat HEAD~1 -- packages/core/`
2. 确认无 core 包文件变更  
**Paths involved**: `apps/reference-cli/src/main.ts`  
**Expected result**: git diff 在 Phase 8 commit 中不含 core 包任何文件

### TC-14: Task 子 agent 上下文隔离（Phase 8 AC2）

**Title**: 主 agent 仅收到子 agent 最终输出，子 agent 无 task 工具  
**Preconditions**: 项目构建环境正常  
**Steps**:
1. 运行 `pnpm turbo run test --filter @agent-core/sdk`
2. 观察 `sub-agent-isolation.test.ts` 中 "context isolation" 用例通过  
**Paths involved**: `packages/sdk/src/__tests__/sub-agent-isolation.test.ts`、`packages/sdk/src/create-agent.ts`  
**Expected result**: task tool 返回子 agent 的 `extractPlainText` 输出；子 agent 尝试调用 task 时返回 `Unknown tool` 错误

### TC-15: SDK 最小配置启动（Phase 8 AC3）

**Title**: 仅传 `modelPort` 即可启动纯对话 agent 并完成一轮对话  
**Preconditions**: 项目构建环境正常  
**Steps**:
1. 运行 `pnpm turbo run test --filter @agent-core/sdk`
2. 观察 `create-agent.test.ts` 中 "minimal config" 用例通过  
**Paths involved**: `packages/sdk/src/__tests__/create-agent.test.ts`、`packages/sdk/src/create-agent.ts`  
**Expected result**: `createAgent({ modelPort })` 返回的 agent 实例可 `run("Hi")` 并得到包含 assistant 文本的 final state

### TC-16: SDK 多轮对话状态衔接（Phase 8 AC3 扩展）

**Title**: 多次 `run()` 调用之间对话历史正确保持  
**Preconditions**: 项目构建环境正常  
**Steps**:
1. 运行 `pnpm turbo run test --filter @agent-core/sdk`
2. 观察 `create-agent.test.ts` 中 "multiple turns" 用例通过  
**Paths involved**: `packages/sdk/src/__tests__/create-agent.test.ts`  
**Expected result**: 第二轮 `run()` 后 `state.messages` 包含前一轮的 user/assistant 消息 + 新轮的消息

### TC-17: stream() 事件输出（Phase 8 扩展）

**Title**: `stream()` 异步生成器正确 yield 事件  
**Preconditions**: 项目构建环境正常  
**Steps**:
1. 运行 `pnpm turbo run test --filter @agent-core/sdk`
2. 观察 `create-agent.test.ts` 中 "stream()" 用例通过  
**Paths involved**: `packages/sdk/src/__tests__/create-agent.test.ts`、`packages/sdk/src/stream-channel.ts`  
**Expected result**: `for await (const event of agent.stream(...))` 收到 `text_delta` 和 `model_done` 事件

---

## 10. E2E 测试用例（端到端集成验证）

> 以下测试用例覆盖从用户输入到最终输出的完整链路，验证各模块协作正确性。优先级高于单元测试中的间接覆盖。

### TC-E1: Shell 取消全链路（AbortSignal 端到端）

**Title**: Agent 取消时 Shell 命令被正确中止  
**Preconditions**: `@agent-core/runtime-node` 构建通过  
**Steps**:
1. 创建 mock ModelPort：第一轮返回 `tool_use(bash, "sleep 30")`，不返回 text
2. 创建 Node Shell adapter + Node FileSystem adapter
3. 创建 Runner，注入 AbortSignal（50ms 后触发）
4. 调用 `runner.run({ type: "user_message", content: "run long command" })`
5. 等待 runner 完成
6. 断言：runner 状态为 `done`；Shell adapter 的子进程已被 kill（通过 mock 或 spy 验证）  
**Paths involved**: `packages/runtimes/node/src/runner.ts`、`packages/runtimes/node/src/shell-tool-executor.ts`、`packages/runtimes/node/src/shell.ts`  
**Expected result**: AbortSignal 从 Runner → shell-tool-executor → bash tool → shell.exec → child.kill 完整传递，进程在超时前被终止

### TC-E2: edit_file fuzzy 缩进保持端到端

**Title**: Fuzzy 匹配替换后原始缩进不丢失  
**Preconditions**: `@agent-core/tools-fs` 构建通过  
**Steps**:
1. 创建 in-memory FileSystem，写入 `  function hello() {\n    return 1;\n  }`（4 空格缩进）
2. 创建 `createEditFileTool(fs)`
3. 调用 handler：`old_string: "function hello() { return 1; }"`（无缩进），`new_string: "function hello() { return 2; }"`
4. 断言：`result.isError` 为 falsy
5. 读取文件内容
6. 断言：新内容为 `  function hello() {\n    return 2;\n  }`（缩进保持 4 空格）  
**Paths involved**: `packages/tools/fs/src/edit-file.ts`、`packages/tools/fs/src/fuzzy-match.ts`  
**Expected result**: `preserveIndentation` 正确检测匹配行前缀空白并应用到 newString 的后续行

### TC-E3: stream-normalize 非标准 provider tool call 缓冲

**Title**: 首 chunk 无 id/name 的 tool call 不丢失  
**Preconditions**: `@agent-core/provider-openai` 构建通过  
**Steps**:
1. 构造 mock raw chunk 序列（模拟 vLLM/Azure 行为）：
   - chunk 1: `tool_calls[{index:0, function:{arguments:'{"path":'}}]`（无 id/name）
   - chunk 2: `tool_calls[{index:0, id:"call_1", function:{name:"read_file", arguments:'"foo.ts"}'}]`
   - chunk 3: `finish_reason:"tool_calls"`
2. 调用 `normalizeStream(mockChunks)`
3. 收集所有 yield 的 ModelEvent
4. 断言：
   - 收到 `tool_use_start`（toolCallId="call_1", toolName="read_file"）
   - 收到 `tool_use_delta`（argumentsDelta 包含缓冲的 `'{"path":'` + `'foo.ts"}'`）
   - 收到 `done`（stopReason="tool_use"）  
**Paths involved**: `packages/providers/openai/src/stream-normalize.ts`  
**Expected result**: `pendingArgs` Map 正确缓冲参数 delta，identity 到达后合并回放，tool call 不丢失

### TC-E4: FileStore atomic write 中断恢复

**Title**: 写入中断后文件不损坏  
**Preconditions**: `@agent-core/store-file` 构建通过  
**Steps**:
1. 创建 FileStore，save 一个有效 snapshot
2. 读取文件确认 JSON 可解析
3. 手动写入截断内容到 `{id}.json`（模拟 crash）
4. 调用 `store.list()`
5. 断言：corrupted 文件被跳过，不抛异常
6. 调用 `store.save()` 写入新 snapshot
7. 断言：新文件写入成功（通过 `.tmp.{pid}` → `rename` 原子路径）  
**Paths involved**: `packages/stores/file/src/index.ts`  
**Expected result**: atomic write（writeFile tmp → rename）保证 crash 后文件要么是旧完整版，要么是新完整版，不会出现截断

### TC-E5: Retriable model error 后 streaming 累加器清零

**Title**: 可重试错误后重试不产生重复内容  
**Preconditions**: `@agent-core/core` 构建通过  
**Steps**:
1. 构造 reducer 状态：`status: "calling_model"`，`_accumulatedText: "partial "`
2. 输入 `model_error`（retriable: true）
3. 调用 `step(state, input, ctx)`
4. 断言：返回的 `state._accumulatedText` 为 `""`（已清零）
5. 断言：返回的 `state._accumulatedToolCalls` 为 `[]`（已清零）
6. 断言：effects 包含 `call_model`（触发重试）  
**Paths involved**: `packages/core/src/reducer.ts`  
**Expected result**: retriable error 分支重置 accumulators，避免重试后内容重复

### TC-E6: glob 工作区边界防逃逸

**Title**: 符号链接或 `..` 模式无法逃逸工作区  
**Preconditions**: `@agent-core/runtime-node` 构建通过  
**Steps**:
1. 创建 NodeFileSystem（root = `/tmp/test-workspace`）
2. 在工作区内创建符号链接 `link` → `/etc/passwd`
3. 调用 `fs.glob("link")`
4. 断言：返回的 paths 不包含 `/etc/passwd`（被边界校验过滤）
5. 创建文件 `../escape.txt`（通过 symlink）
6. 调用 `fs.glob("**/*.txt")`
7. 断言：逃逸文件不在结果中  
**Paths involved**: `packages/runtimes/node/src/filesystem.ts`  
**Expected result**: `glob` 返回的每个路径都通过 `resolveWithinRoot` 校验，逃逸路径被静默过滤

### TC-E7: Network AbortError 透传端到端

**Title**: 取消网络请求时 AbortError 不被包装为通用错误  
**Preconditions**: `@agent-core/runtime-node` 构建通过  
**Steps**:
1. 创建 NodeNetwork adapter
2. 创建 AbortController，立即 abort
3. 调用 `network.fetch({ url: "https://example.com", abortSignal: controller.signal })`
4. 断言：抛出的错误 `name === "AbortError"`
5. 断言：错误 message 不包含 "Network fetch failed"（未被包装）  
**Paths involved**: `packages/runtimes/node/src/network.ts`  
**Expected result**: AbortError 保持原始 identity，调用方可通过 `error.name === "AbortError"` 区分取消与真实网络错误

### TC-E8: SDK + Runner Compaction 端到端

**Title**: 超长对话自动触发上下文压缩  
**Preconditions**: `@agent-core/sdk` 构建通过  
**Steps**:
1. 创建 SDK agent，配置 `compaction: { maxTokens: 200, tokenizer: charTokenizer }`
2. 注入 spy ModelPort：模拟多轮对话使 token 数超过 200
3. 调用 `agent.run()` 多次直到 compaction 触发
4. 断言：spy ModelPort 被调用时 `messages` 包含一个 system message（summary）
5. 断言：summary message 在 preserved messages 中靠前位置（static prefix 友好）  
**Paths involved**: `packages/sdk/src/create-agent.ts`、`packages/runtimes/node/src/runner.ts`、`packages/core/src/compactor.ts`  
**Expected result**: Compactor 正确触发，summary 插入到 static prefix 之后、recent messages 之前

### TC-E9: ToolRouter 能力门控 + 权限策略联合

**Title**: 缺失 capability 的工具不可见，可见工具受权限策略约束  
**Preconditions**: `@agent-core/core` 构建通过  
**Steps**:
1. 构造工具集：`read_file`（requires: filesystem:read）、`bash`（requires: shell:exec）、`edit_file`（requires: filesystem:write）
2. 注入 capabilities：仅 `filesystem:read`、`filesystem:write`（无 `shell:exec`）
3. 调用 `filterVisibleTools(tools, capabilities)`
4. 断言：结果不含 `bash`，含 `read_file` 和 `edit_file`
5. 配置 `permissionConfig`：`edit_file` riskTier 为 `WRITE_LOW` → `ask`
6. 调用 `evaluatePermission(config, "edit_file", "WRITE_LOW")`
7. 断言：返回 `"ask"`  
**Paths involved**: `packages/core/src/tool-router.ts`、`packages/core/src/permission-policy.ts`  
**Expected result**: 门控摘除不可见工具，权限策略约束可见工具的放行决策

### TC-E10: Shell 高风险命令触发 ask + 输出截断

**Title**: bash 高风险命令经 PermissionPolicy 触发 ask；超量输出被截断并声明  
**Preconditions**: `@agent-core/runtime-node` 构建通过  
**Steps**:
1. 创建 Runner，配置 `permissionConfig`（bash → ask）
2. Mock ModelPort：第一轮返回 `tool_use(bash, "rm -rf /tmp/test")`，第二轮返回 text
3. 创建 auto-allow ApprovalGate（自动批准）
4. 调用 `runner.run()`
5. 断言：effects 序列包含 `request_approval`
6. Mock ModelPort 改为：第一轮返回 `tool_use(bash, "echo $(seq 1 100000)")`（超大输出）
7. 断言：tool_result 的 `modelContent` 包含 "truncated" 声明
8. 断言：`displayMetadata.truncated === true`  
**Paths involved**: `packages/runtimes/node/src/runner.ts`、`packages/tools/shell/src/bash.ts`、`packages/core/src/permission-policy.ts`  
**Expected result**: 高风险命令触发 ask 审批流；超量输出被截断到 OUTPUT_LIMIT 并声明

### TC-E11: web_fetch 输出截断 + web_search 认证头

**Title**: web_fetch 超量输出被截断；web_search 携带 API key  
**Preconditions**: `@agent-core/tools-web` 构建通过  
**Steps**:
1. 创建 mock Network adapter：`fetch` 返回 200KB body
2. 创建 `createWebFetchTool(network)`
3. 调用 handler
4. 断言：`modelContent` 长度 ≤ 100001（OUTPUT_LIMIT + truncation note）
5. 断言：`displayMetadata.truncated === true`
6. 创建 `createWebSearchTool(network, { apiKey: "test-key" })`
7. 调用 handler
8. 断言：mock Network 收到的请求 headers 包含 `X-Subscription-Token: test-key`  
**Paths involved**: `packages/tools/web/src/web-fetch.ts`、`packages/tools/web/src/web-search.ts`  
**Expected result**: web_fetch 输出受 OUTPUT_LIMIT 约束；web_search 正确注入认证头

### TC-E12: Runner tool executor 冗余 routeToolCall 已消除

**Title**: tool executor 不再重复调用 routeToolCall  
**Preconditions**: `@agent-core/runtime-node` 构建通过  
**Steps**:
1. 创建 fs/shell/network tool executor
2. 用 spy 包装 `routeToolCall`（统计调用次数）
3. 通过 Runner 执行一个 tool_use 效果
4. 断言：`routeToolCall` 仅被 Runner 调用 1 次（executor 内部不再调用）  
**Paths involved**: `packages/runtimes/node/src/tool-executor.ts`、`packages/runtimes/node/src/shell-tool-executor.ts`、`packages/runtimes/node/src/network-tool-executor.ts`  
**Expected result**: routeToolCall 仅在 Runner 层做一次权威校验，executor 不重复

### TC-E13: Core barrel 无 vitest 污染

**Title**: 生产环境 import `@agent-core/core` 不触发 vitest 加载  
**Preconditions**: `@agent-core/core` 构建通过  
**Steps**:
1. 在非测试环境（普通 Node 脚本）中 `import("@agent-core/core")`
2. 断言：不抛出 vitest 相关错误
3. 确认 `runStoreContractTests` 不在 barrel 导出中
4. 确认可从 `@agent-core/core/testing` 独立导入 `runStoreContractTests`  
**Paths involved**: `packages/core/src/index.ts`、`packages/core/package.json`  
**Expected result**: barrel 零 vitest 污染；测试工具通过独立 `./testing` 导出

### TC-E14: 全量 build → typecheck → lint → test 无回归

**Title**: 所有修复后全量 CI 门控通过  
**Preconditions**: 所有代码修复已提交  
**Steps**:
1. 运行 `pnpm turbo run build typecheck lint test`
2. 断言：退出码为 0
3. 运行 `node scripts/check-core-zero-deps.mjs`
4. 断言：退出码为 0  
**Paths involved**: 所有包  
**Expected result**: 12 个包 + 1 个 app 全部通过 build/typecheck/lint/test 四道门控
