# Pure Agent Core — 通用 Agent 内核

零环境耦合、零副作用核心、能力即注入的通用 agent 内核。纯函数状态机(`step(state, input) → { state, effects[] }`)+ 薄解释器(Runner)+ 可插拔工具包 + 可替换 ports adapter。纯 TypeScript,pnpm + Turborepo monorepo。

---

# 🔴 必读规则（每次任务都必须遵守）

> 以下规则违反成本高、最易被忽略。**开始任何任务前先确认这一节，回复前再自检一次。**

## 1. 核心纯度铁律（Functional Core Purity）— 本项目立身之本

> 核心包 `@volto/core` 是纯函数内核。一旦引入副作用，可重放性、可快照测试、可移植性全部失效。

- **`packages/core/` 内禁止任何 I/O 与隐式副作用**：不得出现 `Date.now()` / `Math.random()` / `crypto.randomUUID()` / `node:*` import / 直接 `fs`。时间、随机、ID、token 计数一律走 `Clock` / `Random` / `Id` / `Tokenizer` port 注入。
- **核心只 import port 接口类型，绝不 import 任何实现**。`@volto/core` 的 `dependencies` 与 `peerDependencies` 必须为空（CI 脚本 `check-core-zero-deps` 强制）。
- **决策逻辑全部为纯函数** —— `step()` reducer、ContextAssembler、Compactor、ToolRouter、PermissionPolicy 不碰 I/O；真正的副作用只通过返回 `Effect[]` 表达，由 Runner 解释执行。
- **重放纪律**：同一串 `AgentInput` 序列两次运行必须产生完全一致的 `(state, effects)` 序列。改动 reducer 后跑重放测试作为回归门。

## 2. 完成标准（Execution Quality Gate）

> "完成任务" ≠ "完成类型、接口、文档、骨架或 TODO"

功能任务必须落地到真实运行路径，缺一不可：

1. **决策—执行闭环完成** — 纯核心产出 `Effect` → Runner 调对应 port → 结果作为 `AgentInput` 回喂核心。
2. **工具接线完成** — 工具经 ToolRouter 校验 + 能力门控后可被模型选用；缺失对应 port 的工具自动从可见集摘除。
3. **错误不中断循环** — 工具 / 模型错误一律归一化为 `isError: true` 的 `ToolResult` 或 `ModelError` input 回喂，**绝不抛异常中断主循环**。
4. **可验证** — `pnpm turbo run typecheck lint test` 通过 + 给出手工验收步骤（或对应 Phase 的 Acceptance Criteria 全绿）。

## 3. 代码改动硬性约束

- **每次代码改动后必须运行 `pnpm turbo run typecheck lint test`**（受影响包即可，用 `--filter`），通过才算完成。
- **依赖单向向下** — `core ← tools-*/providers-*/runtimes-*/stores-* ← sdk ← apps/*`。**`zod` 只允许出现在 `tools/*` 与 `sdk`**，核心只认抽象 `JSONSchema`。
  - **type-import only（适用于 tools-* / providers-* / stores-*）**：这些包只消费 core 的**接口类型**（port 契约、`ToolDefinition` / `ModelEvent` 等），一律 `import type`，不得值导入 core，以免与具体实现耦合。
  - **Runner / sdk 例外**：薄解释器(`runtimes-*` 的 Runner)与 SDK 门面是内核的**执行者**，必须值导入纯函数内核（`step` / `createInitialState` 等)——这是 functional-core / imperative-shell 的本意，导入纯函数不破坏可移植性,不属违规。
- **目录与包命名规则** — 类目目录用**复数**（集合）：`tools/`、`providers/`、`runtimes/`、`stores/`；包名前缀按"该包是什么"取单/复数：`@volto/tools-fs`（一包多工具，复数）、`@volto/provider-openai` / `runtime-node` / `store-memory`（各一个实例，单数）。
- **第三方库构造器参数必须查阅官方文档确认**，不得凭记忆臆测（尤其 OpenAI 兼容 streaming 的 `tool_calls` 分片累积、Zod schema 写法）。

---

# 工作流与质量门

- **能力门控 vs 权限策略** 职责分离：门控（ToolRouter）决定"工具是否对模型可见"，权限（PermissionPolicy）决定"可见工具是否放行（allow / deny / ask）"。改动二者之一时勿混淆职责。
- 静态门:`pnpm turbo run typecheck`、`pnpm turbo run lint`、`pnpm turbo run test`。

---

<details>
<summary>📚 参考信息（技术栈 / 结构 / 命令 / 索引）</summary>

## Tech Stack

- **语言**：TypeScript（strict / `noUncheckedIndexedAccess`）
- **Monorepo**：pnpm workspace + Turborepo（任务依赖图编排 build / test / lint / typecheck）
- **核心**：零依赖 functional core —— `state` / `input` / `effect` 类型、`step()` reducer、ContextAssembler / Compactor / ToolRouter / PermissionPolicy 纯决策、全部 port 接口
- **工具 schema**：Zod（运行时校验 + 推导 JSON Schema，仅 `tools/*` 与 `sdk` 依赖）
- **首个 Provider**：OpenAI 兼容 ModelPort（`/v1/chat/completions` 流式，`baseURL` 可配）
- **Runtime adapter**：Node（FileSystem / Shell / Network / Tokenizer / ApprovalGate）
- **SessionStore**：内存 + sqlite
- **测试**：Vitest（含重放测试、SessionStore 共享行为测试、能力门控测试）

## Project Structure（目标态，详见 Plan 001 §4.2）

```
volto/
├── packages/
│   ├── core/                 # @volto/core   纯函数内核 + ports 接口  ← 零依赖
│   ├── sdk/                  # @volto/sdk     门面 run / stream / resume
│   ├── tools/
│   │   ├── fs/               # @volto/tools-fs     read/edit/write/ls/glob/grep
│   │   ├── shell/            # @volto/tools-shell  bash
│   │   ├── web/              # @volto/tools-web    web_fetch / web_search
│   │   ├── plan/             # @volto/tools-plan   write_todos
│   │   └── agent/            # @volto/tools-agent  task 子 agent
│   ├── providers/
│   │   └── openai/           # @volto/provider-openai
│   ├── runtimes/
│   │   └── node/             # @volto/runtime-node
│   └── stores/
│       ├── memory/           # @volto/store-memory
│       └── file/            # @volto/store-file
├── apps/
│   ├── headless-server/      # HTTP + SSE 网关宿主：仅 wiring + 订阅事件，核心零改动
│   ├── web/                  # Next.js 聊天前端，消费网关的 SSE 协议
│   └── desktop-app/          # Electron 宿主：仅 wiring，含审批弹窗
├── plans/                    # 实施方案文档
└── docs/                     # 架构设计文档
```

> pnpm workspace glob 用混合深度：`packages/*`（core/sdk）+ `packages/*/*`（tools/providers/runtimes/stores）+ `apps/*`。

## Commands（Plan 001 Phase 1 建立后可用）

```bash
pnpm install                              # 安装依赖
pnpm turbo run build                      # 构建所有包
pnpm turbo run typecheck                  # 类型检查 (tsc --noEmit)
pnpm turbo run lint                       # 代码检查 (含 core 零依赖 / 纯度规则)
pnpm turbo run test                       # 运行测试 (vitest)
pnpm turbo run test --filter @volto/core   # 仅测受影响包
node scripts/check-core-zero-deps.mjs     # 校验核心包零运行时依赖
```

## Coding Conventions（细节）

- **核心纯度** — 见 §1；ESLint 在 `packages/core/**` 用 `no-restricted-imports` 禁 `node:*` 与所有 `@volto/*` 实现包，禁 `Date.now` / `Math.random` / `crypto.randomUUID`。
- **ToolResult 双层** — `modelContent`（给模型，精简，超量必截断且声明）+ `displayMetadata`（给 UI / 日志，diff / 行数 / 耗时，经 EventSink 流出）。
- **`edit_file` 编辑格式** — 主格式 `str_replace`（`old_string` / `new_string` / `replace_all?`）；精确匹配失败时 fuzzy fallback（① 忽略行首尾空白 ② 忽略 token 间空白正则）；未 `read_file` 或版本过期的文件拒绝编辑；写回前版本比对。`apply_patch`(diff) 留扩展点，暂不实现。
- **缓存友好** — ContextAssembler 把静态内容（system prompt / tool defs / 项目指令）前置，变量（user 输入 / tool result）后置；工具集变更尽量发生在 turn 边界。
- **确定性** — 时间 / 随机 / ID 全部经 port 注入，支持离线重放与快照测试。

## Documentation Index

| 文档              | 路径                                          | 说明                                       |
| ----------------- | --------------------------------------------- | ------------------------------------------ |
| 架构设计文档      | `docs/pure-volto.md`                     | 纯 Agent 核心架构、模块分解、ports 契约、路线图 M1–M7 |
| 实施方案 Plan 001 | `plans/001-pure-volto-implementation.md` | monorepo 落地方案、目录/包结构、8 个 Phase  |
| 演进路线图        | `docs/roadmap.md`                             | 内核平台化 M8–M14 路线、10 条能力工作流、依赖 DAG  |

</details>
