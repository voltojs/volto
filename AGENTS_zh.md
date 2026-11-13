# Pure Agent Core — 通用 Agent 内核

零环境耦合、零副作用核心、能力即注入的通用 agent 内核。纯函数状态机(`step(state, input) → { state, effects[] }`)+ 薄解释器(Runner)+ 可插拔工具包 + 可替换 ports adapter。纯 TypeScript,pnpm + Turborepo monorepo。

---

# 🔴 必读规则（每次任务都必须遵守）

> 以下规则违反成本高、最易被忽略。**开始任何任务前先确认这一节，回复前再自检一次。**

## 0. 开发阶段定位 —— 判断对错的基准

> volto 尚处开发中，没有外部用户，**没有兼容性包袱**。

- **判断一个设计对不对，标准是"它是否让 volto 成为一个功能完整的 agent"，不是"它是否与现有代码一致"。** 对标 Claude Code / Codex / dsh 这类成熟 agent 应有的完整能力来做判断。
- **已有代码不构成论据。** 任何接口、契约、类型、目录结构、port 签名都可以修改或推翻——它们是当时的判断，不一定对。发现某个设计限制了正确方案，就改它，而不是绕开它。
- **不要为了向后兼容而做出更差的设计**，也不要因为"现在就是这么写的"而复制一个错误。没有需要保护的下游调用方。
- **这不是无谓重构的许可证。** 推翻要服务于当前任务的目标；与当前任务无关的代码不要顺手改。
- **两个例外不在"可推翻"之列**：§1 的核心纯度铁律与 `SAFETY.md` 的安全立场。它们是设计目标本身，不是历史遗留。

## 1. 核心纯度铁律（Functional Core Purity）— 本项目立身之本

> 核心包 `@voltojs/core` 是纯函数内核。一旦引入副作用，可重放性、可快照测试、可移植性全部失效。

- **`packages/core/` 内禁止任何 I/O 与隐式副作用**：不得出现 `Date.now()` / `Math.random()` / `crypto.randomUUID()` / `node:*` import / 直接 `fs`。时间、随机、ID、token 计数一律走 `Clock` / `Random` / `Id` / `Tokenizer` port 注入。
- **核心只 import port 接口类型，绝不 import 任何实现**。`@voltojs/core` 的 `dependencies` 与 `peerDependencies` 必须为空（CI 脚本 `check-core-zero-deps` 强制）。
- **决策逻辑全部为纯函数** —— `step()` reducer、ContextAssembler、Compactor、ToolRouter、PermissionPolicy 不碰 I/O；真正的副作用只通过返回 `Effect[]` 表达，由 Runner 解释执行。
- **重放纪律**：同一串 `AgentInput` 序列两次运行必须产生完全一致的 `(state, effects)` 序列。改动 reducer 后跑重放测试作为回归门。

## 2. 完成标准（Execution Quality Gate）

> "完成任务" ≠ "完成类型、接口、文档、骨架或 TODO"

功能任务必须落地到真实运行路径，缺一不可：

1. **决策—执行闭环完成** — 纯核心产出 `Effect` → Runner 调对应 port → 结果作为 `AgentInput` 回喂核心。
2. **工具接线完成** — 工具经 ToolRouter 校验 + 能力门控后可被模型选用；缺失对应 port 的工具自动从可见集摘除。
3. **错误不中断循环** — 工具 / 模型错误一律归一化为 `isError: true` 的 `ToolResult` 或 `ModelError` input 回喂，**绝不抛异常中断主循环**。
4. **可验证** — 受影响包的 `pnpm turbo run typecheck lint test --filter <包>` 通过（见 §3 的过滤规则）+ 给出手工验收步骤（或对应 Phase 的 Acceptance Criteria 全绿）。

## 2.1 沙箱与边界测试纪律（不可协商）

沙箱曾经**整整三轮 review 都没有生效**（`sandbox-exec -p` 该传 `-f`），而测试全绿。原因是断言没有触碰真实边界。

- **禁止断言「输出为空」来证明拒绝。** 从未执行的沙箱、拼错的命令、崩溃的 runner 都产生空输出。要断言**拒绝本身**：非零退出码 **加上** 该后端方言的拒绝签名。
- **每个平台断言自己的方言**：Seatbelt→`Operation not permitted`、bwrap→`Read-only file system`。禁止用跨后端并集——并集会声称某后端根本不产生的拒绝。
- **先判 runner failure，再判 denial。** 前者意味着命令根本没跑（沙箱基础设施故障），后者意味着隔离正常工作。见 `packages/runtimes/node/src/sandbox-enforcement.ts`。
- **平台相关的测试必须显式 skip**（`itDarwin` 之类），不得在别的平台上假绿。
- **`enforcement` 是运行时事实，不是配置声明。** 任何「有沙箱」的断言都要读 `sandboxEnforcement`，不能读 `config.mode`。

## 3. 代码改动硬性约束

- **只跑受影响包的静态门**：`pnpm turbo run typecheck lint test --filter <受影响包>`。**默认不要跑全仓**——全量类型检查 + 测试慢且吃内存（一次十几分钟、数个 GB），对单包改动没有额外信息量。全仓只在以下情形跑：**跨包契约变更（改了 core 的公开类型/port 契约）、发版前、或明确要求时**。
- **`@voltojs/desktop-app` 一律排除**：它依赖 Electron 二进制、构建慢且对本次改动无验证价值，测试/类型检查命令里必须显式过滤掉：
  ```bash
  # 受影响包（推荐）
  pnpm turbo run typecheck lint test --filter @voltojs/sdk
  # 需要跨包验证时，排除桌面端
  pnpm turbo run typecheck lint test --filter '!@voltojs/desktop-app'
  ```
- **改完依赖链上的包要重建 dist**：`tools-*` / `runtimes-*` / `sdk` 之间存在 `dist` 消费（不是源码直连），跨包测试跑在旧构建上会假绿/假红。跨包改动时先 `pnpm turbo run build --filter <上游包>`，或直接用 `--filter` 带上上游包让 turbo 按依赖图构建。
- **依赖单向向下** — `core ← tools-*/providers-*/runtimes-*/stores-* ← sdk ← apps/*`。**`zod` 只允许出现在 `tools/*` 与 `sdk`**，核心只认抽象 `JSONSchema`。
  - **type-import only（适用于 tools-* / providers-* / stores-*）**：这些包只消费 core 的**接口类型**（port 契约、`ToolDefinition` / `ModelEvent` 等），一律 `import type`，不得值导入 core，以免与具体实现耦合。
  - **Runner / sdk 例外**：薄解释器(`runtimes-*` 的 Runner)与 SDK 门面是内核的**执行者**，必须值导入纯函数内核（`step` / `createInitialState` 等)——这是 functional-core / imperative-shell 的本意，导入纯函数不破坏可移植性,不属违规。
- **目录与包命名规则** — 类目目录用**复数**（集合）：`tools/`、`providers/`、`runtimes/`、`stores/`；包名前缀按"该包是什么"取单/复数：`@voltojs/tools-fs`（一包多工具，复数）、`@voltojs/provider-openai` / `runtime-node` / `store-memory`（各一个实例，单数）。
- **第三方库构造器参数必须查阅官方文档确认**，不得凭记忆臆测（尤其 OpenAI 兼容 streaming 的 `tool_calls` 分片累积、Zod schema 写法）。

---

# 工作流与质量门

- **能力门控 vs 权限策略** 职责分离：门控（ToolRouter）决定"工具是否对模型可见"，权限（PermissionPolicy）决定"可见工具是否放行（allow / deny / ask）"。改动二者之一时勿混淆职责。
- 静态门:`pnpm turbo run typecheck lint test --filter <受影响包>`（**不要默认全仓，`@voltojs/desktop-app` 一律排除**，见 §3）。
- **计划最终要出自测报告时,用 `writing-selftest-reports` skill —— 在写 plan 时就用,不是等到最后要报告时**。它要求 plan 顶部建功能点台账、每个 task 末尾追加证据、末尾单独一个 task 由全新上下文生成报告。到最后才想起来,执行痕迹只剩 git 历史,报告只能靠考古重建。

## 用户文档（`docs/user/`）—— 改到用户感知面就必须同步

用户文档与开发文档受众不同：`docs/superpowers/` 写「为什么这样设计」，`docs/user/` 只写「怎么用」。写作规范见 `docs/user/WRITING.md`。

- **判定**：这次改动是否影响**使用者**看得见 / 配得了 / 能感知的东西（界面文案、菜单、配置键与默认值、错误信息、权限语义、工具可见性、安装步骤），或**集成者**依赖的公开面（`@voltojs/sdk` 导出、`createAgent` 选项、端口契约、事件类型、网关路由）。命中就必须在**同一提交**内更新 `docs/user/`。
- **生成页不许手改**：`using/reference/tools.md`、`using/reference/config.md`、`integrating/reference/gateway-api.md`、`integrating/reference/sdk-exports.md` 由 `pnpm docs:gen` 产出；改代码或改对应 notes JSON（`docs/user/reference/*-notes.json` / `config-sections.json`）再生成。新增工具 / 配置字段 / 路由却不补 notes，`docs:check` 直接失败——这是有意的。
- **收尾跑 `pnpm docs:check`**（需要先 `pnpm turbo run build`）。表面变了但没同步基线时它会失败并点名该改哪几页；确认对用户无感则 `pnpm docs:ack "理由"`，理由会进 diff。
- **不要把 spec / plan 的内容搬进用户文档**，也不要在 `using/` 里解释实现细节（reducer / port / Effect 这类词属于 `integrating/`）。
- 新建页必须在 `docs/user/README.md` 登记，否则孤儿页检查失败。

---

<details>
<summary>📚 参考信息（技术栈 / 结构 / 命令 / 索引）</summary>

## Tech Stack

- **语言**：TypeScript（strict / `noUncheckedIndexedAccess`）
- **Monorepo**：pnpm workspace + Turborepo（任务依赖图编排 build / test / lint / typecheck）
- **核心**：零依赖 functional core —— `state` / `input` / `effect` 类型、`step()` reducer、ContextAssembler / Compactor / ToolRouter / PermissionPolicy 纯决策、全部 port 接口
- **工具 schema**：Zod（运行时校验 + 推导 JSON Schema，仅 `tools/*` 与 `sdk` 依赖）
- **Provider**：pi-ai（宿主默认，多 provider 目录 + 模型能力声明）、OpenAI 兼容、Anthropic
- **Runtime adapter**：Node（FileSystem / Shell / Network / Tokenizer / ApprovalGate / Sandbox）、browser、edge
- **Store**：memory / file / jsonl / sqlite / postgres（共用同一套 SessionStore 合同测试）
- **测试**：Vitest（含重放测试、SessionStore 共享行为测试、能力门控测试）

## Project Structure（现状）

```
volto/
├── packages/
│   ├── core/                 # @voltojs/core   纯函数内核 + ports 接口  ← 零依赖
│   ├── sdk/                  # @voltojs/sdk    门面 run / stream / resume
│   ├── eval/                 # @voltojs/eval   评测
│   ├── tools/                # 每个子目录一个工具包
│   │   ├── fs shell web plan agent ask browser code data document mcp schedule vcs
│   │   ├── common/           # @voltojs/tools-common  defineTool 等共享设施
│   │   └── skill/            # @voltojs/tool-skill（注意：单数前缀，与其它 tools-* 不同）
│   ├── providers/            # openai / anthropic / pi-ai   → @voltojs/provider-*
│   ├── runtimes/             # node / browser / edge        → @voltojs/runtime-*
│   ├── stores/               # memory / file / jsonl / sqlite / postgres → @voltojs/store-*
│   ├── embedders/            # openai                       → @voltojs/embedder-*
│   └── memories/             # inmemory                     → @voltojs/memory-*
├── apps/
│   ├── gateway/      # HTTP + SSE 网关宿主：仅 wiring + 订阅事件，核心零改动
│   ├── web/                  # Next.js 聊天前端，消费网关的 SSE 协议
│   └── desktop-app/          # Electron 宿主：仅 wiring，含审批弹窗
├── docs/                     # 架构设计 + 演进路线
│   └── superpowers/          # 每个特性的 spec 与 plan
└── scripts/                  # 仓库级校验与分析脚本
```

> pnpm workspace glob 用混合深度：`packages/*`（core/sdk/eval）+ `packages/*/*`（tools/providers/runtimes/stores/embedders/memories）+ `apps/*`。包名前缀按"该包是什么"取单/复数，见上文命名规则。

## Commands

```bash
pnpm install                              # 安装依赖
pnpm turbo run build                      # 构建所有包
pnpm turbo run typecheck                  # 类型检查 (tsc --noEmit)
pnpm turbo run lint                       # 代码检查 (含 core 零依赖 / 纯度规则)
pnpm turbo run test                       # 运行测试 (vitest)
pnpm turbo run test --filter @voltojs/core   # 仅测受影响包
node scripts/check-core-zero-deps.mjs     # 校验核心包零运行时依赖
```

## Coding Conventions（细节）

- **核心纯度** — 见 §1；ESLint 在 `packages/core/**` 用 `no-restricted-imports` 禁 `node:*` 与所有 `@voltojs/*` 实现包，禁 `Date.now` / `Math.random` / `crypto.randomUUID`。
- **ToolResult 双层** — `modelContent`（给模型，精简，超量必截断且声明）+ `displayMetadata`（给 UI / 日志，diff / 行数 / 耗时，经 EventSink 流出）。
- **`edit_file` 编辑格式** — 主格式 `str_replace`（`old_string` / `new_string` / `replace_all?`）；精确匹配失败时 fuzzy fallback（① 忽略行首尾空白 ② 忽略 token 间空白正则）；未 `read_file` 或版本过期的文件拒绝编辑；写回前版本比对。`apply_patch`(diff) 留扩展点，暂不实现。
- **缓存友好** — ContextAssembler 把静态内容（system prompt / tool defs / 项目指令）前置，变量（user 输入 / tool result）后置；工具集变更尽量发生在 turn 边界。
- **确定性** — 时间 / 随机 / ID 全部经 port 注入，支持离线重放与快照测试。

## Documentation Index

**判断"某能力现在是什么样"时，代码是唯一真相源。** 下面的文档解释**为什么**是这样，不保证描述现状。

| 文档                | 路径                        | 用途                                                     | 时效 |
| ------------------- | --------------------------- | -------------------------------------------------------- | ---- |
| **用户文档**        | `docs/user/`                | 面向使用者与集成者的手册；改到用户感知面时必须同步（见「用户文档」一节） | 随代码演进 |
| 架构设计文档        | `docs/pure-agent-core.md`   | 纯函数内核架构、模块分解、ports 契约——纯度铁律的出处      | 长期有效 |
| **安全立场**        | `SAFETY.md`                 | 威胁模型：防「模型犯错」，**不承诺**防「模型被诱导」；边界的实际强度与已知不保护项 | 长期有效 |
| 特性设计（spec）    | `docs/superpowers/specs/`   | 每个特性的设计取舍，文件名带日期                          | 写作时点的决策记录 |
| 特性实施方案（plan） | `docs/superpowers/plans/`   | 与 spec 一一对应的分任务实施方案与验收标准                | 写作时点的执行记录 |
| 演进路线图          | `docs/roadmap.md`           | 内核平台化的方向与不变量                                  | 历史方向文档，里程碑表不再跟踪进度 |

**查特性来龙去脉的正确姿势**：按日期倒序看 `docs/superpowers/specs/`（先设计后实施，spec 比 plan 短得多），找到对应主题再读同名 plan。不要把某份 spec/plan 的内容当作现状——它记录的是**当时**的决定，之后可能被更晚的 spec 推翻。

</details>
