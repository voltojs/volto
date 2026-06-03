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
| 适配层 | 无 | OpenAI 兼容 ModelPort、Node 文件/shell/network adapter、内存 + sqlite SessionStore |
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
7. 实现 PermissionPolicy、RequestApproval/ApprovalDecision 闭环、SessionStore(内存 + sqlite)、ApprovalGate(auto-allow + 交互式)。
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
    sqlite/            @agent-core/store-sqlite
apps/
  reference-cli/       仅依赖 sdk,做 wiring + 订阅事件
```

**决策 2 — 命名规则:目录用复数(集合),包名前缀按"该包是什么"取单/复数**。这是刻意的语义化区分,不是疏忽:

- `tools-fs` —— 一个**装多个工具**的包,前缀复数天然正确;
- `provider-openai` / `runtime-node` / `store-memory` —— 各是**一个** provider / runtime / store,前缀单数正确。

故目录 `providers/`(复数集合)↔ 包名 `provider-openai`(单数实例)的表面不一致是**有原则的**:容器复数、实例按义。

依赖只能向下:`core ← tools-*/provider-*/runtime-*/store-* ← sdk ← apps/*`,全部仅以 type import 依赖 `@agent-core/core`。

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
**Commit**: ac1c696 feat(plan-001): phase 3 - Runner 与 OpenAI 兼容 ModelPort

<!-- Backfill after execution:
**Reviewed**: <date> by reviewer
**Commit**: <commit hash> <commit message subject>
-->

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
- [ ] 实现 ToolRouter:对每个 tool_use 用工具的 JSONSchema 校验入参;能力门控——`requires` 未被宿主满足的工具从可见集摘除;非法入参 → `isError` ToolResult 回喂
- [ ] 实现 Node `FileSystem` adapter:`read`/`write`/`stat`/`list`/`glob`/`grep`,路径 resolve 后校验在工作区内,越界返回错误
- [ ] 实现 `read_file`:带行号(`cat -n` 风格)、`offset`/`limit` 分页、上限截断(声明截断)、记录"已读文件 + 版本"到 state
- [ ] 实现 `edit_file`:str_replace 主格式;0 次/多次匹配返回明确错误结果;fuzzy fallback(忽略行首尾空白 → 忽略 token 间空白正则);先读后改门控;写回前版本比对
- [ ] 实现 `write_file`:新建(`WRITE_LOW`)/ 覆盖(`WRITE_HIGH`)区分;覆盖前要求先 read
- [ ] 实现 `ls` / `glob`(按修改时间排序)/ `grep`(底层 ripgrep,输出模式 + 截断告知)
- [ ] ToolResult 双层:`modelContent` + `displayMetadata`(diff/行数/耗时)
- [ ] 端到端测试:读文件 → 改文件

**Acceptance Criteria**:
1. `edit_file` 精确匹配失败时 fuzzy fallback 能正确命中并以原文实际内容替换。
2. `edit_file` 对 0 次 / 多次匹配返回明确错误结果(非异常)。
3. 未 `read_file`(或版本过期)的文件 `edit_file` 被拒绝。
4. 端到端跑通"读文件 → 改文件";越界路径被 FileSystem adapter 拒绝。

<!-- Backfill after execution:
**Reviewed**: <date> by reviewer
**Commit**: <commit hash> <commit message subject>
-->

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
- [ ] 实现 ContextAssembler:把 system prompt / tool defs / 项目指令(静态)前置,user 输入 / tool result(变量)后置,保证可缓存前缀稳定
- [ ] 实现 Tokenizer adapter(char-heuristic)与确定性测试版
- [ ] 实现 Compactor:依 Tokenizer 估算判断是否压缩、压缩哪些消息;保留近因 + 关键决策 / 文件路径 / 未完成 todo;实际摘要走 `CallModel` 效果(调便宜模型)
- [ ] 测试:超长 history 触发 Compactor 并保留关键信息;工具集不变时静态前缀稳定

**Acceptance Criteria**:
1. 超长 history 时 Compactor 正确触发并保留关键信息(近因 / 文件路径 / 未完成 todo)。
2. 工具集不变时 ContextAssembler 产出的静态前缀稳定(逐字节可缓存)。

<!-- Backfill after execution:
**Reviewed**: <date> by reviewer
**Commit**: <commit hash> <commit message subject>
-->

---

### Phase 6: 权限、HITL 与会话恢复(M5)

**Goal**: 实现 PermissionPolicy、RequestApproval/ApprovalDecision 闭环、SessionStore(内存 + sqlite)、ApprovalGate(auto-allow + 交互式)。

**Files covered**:
- `packages/core/src/permission-policy.ts`(纯决策)
- `packages/stores/memory/src/index.ts`
- `packages/stores/sqlite/src/index.ts`
- `packages/runtimes/node/src/approval-gate.ts`(auto-allow + 终端交互)
- `packages/core/src/testing/store-contract.ts`(共享行为测试套件)
- 对应 `__tests__/`

**Tasks**:
- [ ] 实现 PermissionPolicy:依 `riskTier` + 配置输出 `allow` / `deny` / `ask`
- [ ] reducer/Runner 支持 `RequestApproval` 效果 → `ApprovalGate.ask` → `ApprovalDecision` 回喂;`ask` 时落 `Checkpoint` 暂停
- [ ] 实现内存 SessionStore 与 sqlite SessionStore:`save` / `load` / `list`
- [ ] 抽取 SessionStore 共享行为测试套件,两种实现都跑通
- [ ] 实现 SDK 层 `resume(sessionId, decision)` 的核心支撑(从 checkpoint 重建 state 续跑)—— SDK 门面在 Phase 8 组装
- [ ] 实现 ApprovalGate:auto-allow(策略自动)+ 终端交互式
- [ ] 测试:写/高风险工具触发 `ask` → 中断落盘 → resume 续跑等价

**Acceptance Criteria**:
1. 写 / 高风险工具触发 `ask`,中断后状态完整落盘(snapshot 可序列化)。
2. 从 checkpoint 重建续跑(`resume(sessionId, decision)`)结果与不中断等价。
3. 内存 store 与 sqlite store 通过同一组行为测试。

<!-- Backfill after execution:
**Reviewed**: <date> by reviewer
**Commit**: <commit hash> <commit message subject>
-->

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
- [ ] 实现 Node `Shell` adapter:子进程执行,流式 stdout/stderr/exit,`timeout` / `run_in_background` / 工作目录约束
- [ ] 实现 `bash` 工具:输出截断并声明;高风险命令(删除/推送/网络/提权)经 PermissionPolicy 必 `ask`
- [ ] 实现 Node `Network` adapter 与 `web_fetch` / `web_search`
- [ ] 实现 `write_todos`(纯状态操作),发 `todoListUpdated` 事件
- [ ] 能力门控集成测试:未注入 Shell port 时可见工具集不含 `bash`

**Acceptance Criteria**:
1. 未注入 Shell port 时可见工具集不含 `bash`,模型无法调用(门控测试通过)。
2. `bash` 高风险命令触发 `ask`;输出流式回传且超量截断并声明。

<!-- Backfill after execution:
**Reviewed**: <date> by reviewer
**Commit**: <commit hash> <commit message subject>
-->

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
- [ ] 实现 `task` 子 agent:新建核心实例(独立 context window + 工具集,共享 ModelPort / 工具注册表),最终输出作为一条 tool_result 返回主循环(上下文隔离)
- [ ] 实现 SDK `createAgent({ model, tools, store, approval, fs, shell, ... })`:缺省 port 用内存 / no-op / real 时间随机兜底
- [ ] 实现 `run(input)`(跑完一个 turn 返回最终消息)、`stream(input)`(实时 event 迭代)、`resume(sessionId, decision)`
- [ ] 实现参考 CLI:wiring(选 adapter + 注入能力 + 订阅事件 + stdout 渲染),核心包零改动
- [ ] 测试:参考宿主仅 wiring 跑通完整流程;`task` 子 agent 上下文隔离;SDK 最小配置(仅 model)启动纯对话 agent

**Acceptance Criteria**:
1. 参考宿主仅通过 wiring(选 adapter)跑通完整流程,`@agent-core/core` 包零改动(git diff 在本 Phase 不含 core 包)。
2. `task` 子 agent 上下文隔离,主 agent 仅收到其最终输出。
3. SDK 最小配置(仅 `model`)可启动一个纯对话 agent 并完成一轮对话。

<!-- Backfill after execution:
**Reviewed**: <date> by reviewer
**Commit**: <commit hash> <commit message subject>
-->

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
