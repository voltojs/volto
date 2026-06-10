# Plan 004 — M10 工具生态（MCP / 代码智能 / 结构化编辑 / 扩展工具目录）

> **Status**: Draft
> **Owner**: TBD
> **Created**: 2026-06-09
> **Depends on**: 演进路线图 [docs/roadmap.md](../docs/roadmap.md) M10（WS-5）；架构设计 [docs/pure-agent-core.md](../docs/pure-agent-core.md)；Plan 002（M8：内核引擎深化 + 9 个纯类型端口契约，其中 **ToolSource** 是本 Plan 的关键消费点）；Plan 001（M1–M7 已交付）
> **Target area**: `packages/tools/{mcp,code,edit,vcs,browser,data,files,ask}`（新增工具包）、`packages/runtimes/node/src/*`（新增 adapter）、`packages/core/src/tool-router.ts`（可见集动态过滤）、`packages/sdk/src/{create-agent,defaults}.ts`（ToolSource 接线）、`apps/reference-cli`（wiring）

## 1. 背景

### 1.1 问题陈述

M1–M7 交付的工具集偏基础（fs / shell / web / plan / agent），M8 为动态工具源、沙箱、调度等能力立了 9 个纯类型端口契约（尤其是 **ToolSource**），但尚无任何工具源 / 扩展工具落地。要把内核从"对话 + 基础工具跑通"推进到 [roadmap](../docs/roadmap.md) 所述"对齐主流的核心一跳"，M10 须沿 WS-5 补齐工具生态：

- **接入外部生态**：实现 M8 `ToolSource` 端口的 **MCP 客户端适配器**，把外部 MCP server 的 tools / resources / prompts 动态接入可见工具集，结果归一回喂，server 缺席自动摘除。
- **补齐代码工作流**：代码智能（LSP）、结构化编辑（AST/tree-sitter）、扩展编辑格式（apply_patch / multi_edit / notebook）、测试-构建-Git 结构化工具。
- **扩展工具目录**：browser/computer-use、db/http、文件格式（PDF/docx/xlsx/image）、`ask_user`。
- **守住工具数量上限**：默认可见工具集 ≤ ~20，新增工具大量增加后须按作用域/模式动态过滤（见架构 §4.6）。

全程严守工具铁律：新工具走 `defineTool`（zod，仅 tools/sdk）、声明 `requires` 能力 + `riskTier`、错误归一为 `isError: true` 的 `ToolResult` 不抛异常、`ToolResult` 双层（`modelContent` 精简+截断声明 / `displayMetadata` 给 UI）、缺对应 port/adapter 的工具自动从可见集摘除（复用 M1–M7 的 `filterVisibleTools` 能力门控）。

### 1.2 现状审计

| 维度 | 当前实现 | 目标状态 |
|---|---|---|
| 工具源 | 工具集为**编译期静态数组**，SDK 拼装时一次性传入；无运行时动态注入 | `ToolSource` 端口落地 MCP 客户端 adapter；外部 server 的工具运行时进出可见集，归一回喂 |
| 代码智能 | 无；只能靠 `grep` + `read_file` 文本检索 | LSP 工具返回结构化跳转/引用/重命名/诊断/hover |
| 结构化编辑 | `edit_file` 仅 `str_replace` + fuzzy（架构 §8.3） | 新增 AST/tree-sitter 结构化编辑；`apply_patch` / `multi_edit` / `notebook` 编辑落地，按模型能力选格式 |
| 测试/构建/Git | 仅能裸 `bash` 调用，输出非结构化、pass/fail 靠模型解析 | 结构化工具（`run_tests` / `build` / `git_*`）返回结构化 pass/fail / diff / 变更摘要 |
| 外设工具 | 无 browser/computer-use、db、http（仅 `web_fetch`）、文件格式、`ask_user` | 上述工具按 capability 门控落地；缺 adapter 自动不可见 |
| 工具数量治理 | 默认工具约 11 个，未触发上限 | 工具总量超阈值时按作用域/模式动态过滤，默认可见 ≤ ~20（架构 §4.6） |

### 1.3 设计目标

1. **MCP 即 ToolSource**：MCP 客户端是 M8 `ToolSource` 端口的一个 adapter，**不新定义端口类型**；外部 server 的工具/资源/prompt 经统一归一进入可见集，server 缺席（未连接 / 断线）时其工具自动摘除——完全复用既有能力门控语义。
2. **工具即注入、零核心耦合**：所有新工具走 `defineTool`，声明 `requires` + `riskTier`；缺对应 runtime adapter 时（如无 LSP / browser / db adapter）工具不可见；核心 reducer 不为任何具体工具写分支。
3. **错误不中断循环**：MCP 调用失败、LSP server 无响应、浏览器超时、SQL 报错等一律归一为 `isError: true` 的 `ToolResult` 回喂，绝不抛异常。
4. **可见集治理**：工具大量增加后引入按作用域/模式的动态可见集过滤（核心纯决策，扩展 `filterVisibleTools` 调用点），保证默认可见 ≤ ~20。
5. **可重放不破**：新工具的时间/随机/ID/网络全部经既有 port 或新 adapter 注入；MCP/LSP/browser 的 I/O 全在 adapter 层，核心仍只见归一化 `ToolResult`。
6. **向后兼容**：现有 fs/shell/web/plan/agent 工具与既有测试零回归；不接入任何新工具源时行为与 M7 一致。

## 2. Goals

1. **MCP 客户端**：落地 `@agent-core/tools-mcp` —— 实现 M8 `ToolSource` 端口，连接外部 MCP server（stdio / HTTP-SSE 传输），把其 tools/resources/prompts 归一为内核 `ToolDefinition` + `ToolResult`，动态进出可见集，server 缺席自动摘除；SDK 侧接线动态工具源。
2. **代码智能（LSP）**：落地 `@agent-core/tools-code` + LSP runtime adapter —— `lsp_definition` / `lsp_references` / `lsp_rename` / `lsp_diagnostics` / `lsp_hover` 返回结构化结果；缺 adapter 时不可见。
3. **结构化编辑 + 扩展编辑格式**：扩展 `@agent-core/tools-fs`（或新增 `@agent-core/tools-edit`）落地 AST/tree-sitter 结构化编辑、`apply_patch`（diff）、`multi_edit`（单文件多处原子编辑）、`notebook` 编辑；编辑工具可按模型能力选格式，沿用"先读后改 + 版本比对"门控。
4. **测试-构建-Git 结构化工具**：落地 `@agent-core/tools-vcs`（git）与测试/构建工具 —— 结构化 pass/fail / 失败用例 / diff / 提交摘要，非裸 bash 文本。
5. **外设与数据工具**：落地 `@agent-core/tools-browser`（browser/computer-use，经 adapter）、`@agent-core/tools-data`（db / http）、`@agent-core/tools-document`（PDF/docx/xlsx/image 读取归一为结构化文本/多模态；命名避免与既有 `tools-fs` 文件系统工具混淆）、`ask_user`（经 ApprovalGate/EventSink 询问，归一回喂）。
6. **可见集动态过滤**：核心引入按作用域/模式的可见集过滤策略（纯决策），默认可见 ≤ ~20；工具集变更尽量发生在 turn 边界（缓存友好，架构 §11）。
7. 全程满足验收 + `pnpm turbo run typecheck lint test` 通过 + `check-core-zero-deps` 通过 + 既有重放/工具/HITL 测试不回归。

## 3. Non-Goals

1. **不**重新定义任何 M8 端口类型 —— 本 Plan 只**消费/实现** `ToolSource`（及按需 `Secrets`/`Sandbox` 兜底），端口类型一律以 Plan 002 落地的为准。
2. **不**实现通用插件系统 / hooks / 斜杠命令 / skills（归 Plan 007 / M13）；MCP 客户端是"工具源 adapter"，不是通用插件框架。
3. **不**把本 agent **暴露为 MCP server**（归 Plan 008 / M14）；M10 只做 MCP **客户端**。
4. **不**落地调度/后台任务工具（`Scheduler` 端口消费归 Plan 005 / M11 横切轨道）。
5. **不**实现执行沙箱 / egress 管控 / guardrails / secrets 真实金库（归 Plan 005 / M11）；browser/db 等高风险工具在 M10 只做能力门控 + `riskTier` + HITL，隔离硬化留 M11。
6. **不**实现多 provider / 缓存 / RAG / 分层记忆（归 Plan 003 / M9）。
7. **不**引入 `Date.now()` / 随机等隐式副作用进核心；所有工具 I/O 在 adapter 层。

## 4. Key decisions

### 4.1 MCP 客户端 = ToolSource 的一个 adapter（不新增端口）

**决策**：`@agent-core/tools-mcp` 实现 M8 `ToolSource` 端口（`list()` 返回当前可用 `ToolDefinition[]`、`onChange(cb)` 在 server 连接/断开/工具列表变更时通知）。内部维护到一个或多个 MCP server 的连接（传输：stdio 子进程 / HTTP-SSE），把 server 暴露的 `tools` 映射为 `ToolDefinition`（input JSON Schema 直接透传到核心抽象 `JSONSchema`），把 `resources` / `prompts` 以受控工具（如 `mcp_read_resource` / `mcp_get_prompt`）形式暴露。工具调用经连接转发，server 返回结果归一为 `ToolResult`。

**理由**：roadmap 与归属边界图明确"MCP 客户端 = 实现 M8 ToolSource 的 MCP 适配"。把 MCP 做成 ToolSource adapter，复用既有能力门控（缺席自动摘除）与归一化结果链路，核心零改动；多个 ToolSource（未来插件 ←M13）可叠加，互不耦合。

**取舍**：MCP server 的 input schema 是 JSON Schema 而非 Zod，故 MCP 工具**不经 `defineTool`**（zod 仅约束本仓内置工具），而是由 adapter 直接产出 `ToolDefinition` + 在 adapter 内做 JSON Schema 校验失败归一为 `isError`；本仓自研工具仍一律走 `defineTool`。

### 4.2 server 缺席 = 工具自动摘除（复用能力门控）

**决策**：ToolSource 聚合出的工具进入"可见工具候选集"前，先与 `availableCapabilities` 做既有 `filterVisibleTools` 过滤；MCP 工具统一声明一个 `mcp:<serverId>` 能力，server 在线时该能力存在、断线时移除，触发 `onChange` → SDK/Runner 在 turn 边界重算可见集。server 从未配置或连接失败 → 该能力从不注入 → 工具从不可见。

**理由**：与架构 §4.5「缺失能力的工具自动从可见集摘除」完全同构，无需为 MCP 写专门的"是否可用"分支；turn 边界重算保证缓存前缀稳定（架构 §11）。

### 4.3 结构化编辑落点：扩展 tools-fs 编辑能力，apply_patch/multi_edit 同包

**决策**：`apply_patch`（diff，架构 §4.3 预留扩展点）、`multi_edit`（单文件多处原子替换，全成功才写回，否则整体回滚归一为 `isError`）、`notebook` 编辑落在编辑工具域；AST/tree-sitter 结构化编辑作为独立工具（`ast_edit`，按符号/节点定位编辑）。沿用既有"未 `read_file` 或版本过期拒绝编辑 + 写回前版本比对"门控。编辑格式按模型能力选择：默认 `str_replace`，强模型可选 `apply_patch`/`multi_edit`（验收标准 2）。

**理由**：编辑工具接口设计对编码能力影响极大（架构 §4.3）；多格式并存让宿主按模型能力择优；原子性 + 先读后改门控是既有不变量，新格式必须继承，不得绕过。

### 4.4 测试/构建/Git 工具：结构化 pass/fail，底层可走 Shell 但输出归一

**决策**：`run_tests` / `build` / `git_status` / `git_diff` / `git_commit` 等工具底层可经既有 `Shell` port 执行命令，但**职责是解析输出为结构化结果**（pass/fail 数、失败用例名 + 摘要、变更文件 + 行数、提交 hash），而非把裸 stdout 丢给模型。高风险操作（`git_commit` / `git_push` = `WRITE_HIGH`/`IRREVERSIBLE`）经 `PermissionPolicy` 触发 `ask`。

**理由**：roadmap 明确"结构化 pass/fail，非裸 bash"；结构化结果省 token、提升模型决策质量；复用 Shell port 不必新增 runtime 能力，但归一化在工具层完成。

### 4.5 browser/db/files/ask_user：各自 capability 门控 + 对应 adapter

**决策**：
- **browser/computer-use** → 声明 `browser:control`（导航/点击/截图/读取），经新增 Browser runtime adapter；缺 adapter 不可见；`riskTier` 偏高（页面副作用），高风险动作可 `ask`。
- **db** → 声明 `db:query`（只读查询 `READ_ONLY`）/ `db:exec`（写 `WRITE_HIGH`），经 Database adapter；连接串经 `Secrets` 端口解析（M8 已立契约，M10 用兜底）。
- **http** → 复用既有 `Network` port（区别于 `web_fetch` 的结构化 HTTP 工具：自定义 method/headers/body），声明 `network`。
- **文件格式（PDF/docx/xlsx/image）** → 扩展 `read_file` 多模态语义（架构 §8.2）或独立 `read_document` 工具，经 FileSystem + 解析 adapter，归一为结构化文本 / image block。
- **`ask_user`** → 无外部能力（经 `ApprovalGate` / `EventSink` 向宿主提问，回答作为 input 回喂）；归一为 `ToolResult`，宿主缺交互能力时返回 `isError`。

**理由**：严格遵循"能力即注入 + 缺席摘除"；db 凭据走 `Secrets` 而非明文，预接 M11 secrets 作用域；http 复用 Network 不重复造网络能力。

### 4.6 工具数量治理：核心引入按作用域的可见集过滤（纯决策）

**决策**：在核心新增"可见集过滤策略"纯函数（扩展 `filterVisibleTools` 的调用点 / ContextAssembler 取工具处）—— 在能力门控之后，再按"作用域/模式 + 工具优先级 + 上限 N（默认 ~20）"裁剪可见集；裁剪发生在 turn 边界。具体作用域规则（如按当前任务标签、按工具组）作为配置注入，核心只执行确定性裁剪。

**理由**：架构 §4.6 明确工具过多拖垮模型选择；M10 工具总量将远超 20，必须治理；裁剪是纯决策（输入 = 工具集 + 作用域配置 + 上限，输出 = 可见子集），可重放、可快照测试；turn 边界变更保证缓存前缀稳定。

### 4.7 与其它 Plan 的边界

> 归属边界图（唯一事实源）：M8=002 / M9=003 / **M10=004（本 Plan）** / M11=005 / M12=006 / M13=007 / M14=008。

**本 Plan owns（M10 / WS-5）**：
- MCP **客户端**（实现 M8 `ToolSource` 的 MCP 适配）；代码智能 LSP 工具；AST/tree-sitter 结构化编辑；`apply_patch` / `multi_edit` / `notebook`（扩展 tools-fs 编辑）；测试/构建/Git 结构化工具；browser/computer-use 工具；db/http 工具；文件格式（PDF/docx/xlsx/image）工具；`ask_user` 工具；上述工具所需 runtime adapter；工具可见集动态过滤。

**consumes（不重新定义）**：
- M8（002）的 **`ToolSource`** 端口类型（MCP 客户端实现之）、按需 `Secrets` / `Sandbox` 端口（M10 用兜底，真实实现归 M11）；M1–M7 既有能力门控（`filterVisibleTools`）、`defineTool`、`Shell` / `Network` / `FileSystem` / `ApprovalGate` / `EventSink` port。

**excludes（明确划给兄弟 Plan）**：
- 多 provider / 缓存 / 指令加载 / RAG / 分层记忆 / 结构化输出 / 成本计量 → **Plan 003（M9）**。
- 执行沙箱 / egress 管控 / guardrails（注入防御，对 MCP/web 不可信内容尤其相关）/ secrets 真实金库 / 调度后台任务工具 → **Plan 005（M11）**（M10 仅做能力门控 + riskTier + HITL，隔离硬化与防注入留 M11）。
- 可观测 tracing / 多 agent 编排 → **Plan 006（M12）**。
- 通用**插件系统** / hooks / 命令 / skills / 声明式 agent → **Plan 007（M13）**（MCP 客户端是工具源 adapter，非通用插件框架）。
- 把 agent **暴露为 MCP server** / stores / server / IDE / CI / browser-edge 宿主 → **Plan 008（M14）**。

**潜在重叠点的显式处置**：
1. **MCP 客户端 vs M13 插件系统**：M10 只做 ToolSource adapter（连一个具体协议 = MCP）；M13 的插件系统是"把工具/provider/hook 作为可安装包"的通用框架，会**复用**本 Plan 的 ToolSource 接线点，不在 M10 实现。
2. **guardrails / 防注入**：MCP / browser / web 引入大量不可信外部内容，防注入与隔离是**真实风险**但归 M11；M10 仅在文档与风险表标注，工具结果照常归一回喂，不在 M10 做内容净化。
3. **db 凭据**：M10 经 `Secrets` 端口（M8 契约 + M10 兜底）解析连接串，真实金库/作用域归 M11。

## 5. 实现计划

> Phase 1（MCP 客户端 = ToolSource）是 M10 的核心一跳，最先做、独立价值最高；Phase 2 可见集治理为后续大批工具落地铺路（在工具激增前先建闸）；Phase 3 编辑格式与结构化编辑、Phase 4 代码智能 LSP、Phase 5 测试/构建/Git、Phase 6 外设/数据/文件/ask_user 依次叠加。每个新工具包遵循目录复数 / 包名单数命名（`tools/mcp` → `@agent-core/tools-mcp`）。严格串行、逐 Phase review + 单独 commit。

### Phase 1: MCP 客户端（实现 ToolSource 端口）

**Goal**: `@agent-core/tools-mcp` 实现 M8 `ToolSource` 端口，连接外部 MCP server（stdio + HTTP-SSE 传输），把其 tools/resources/prompts 归一接入可见工具集、结果归一回喂；server 缺席/断线时工具自动摘除（复用能力门控）；SDK 接线动态工具源。

**Files covered**:
- `packages/tools/mcp/`（新增包 `@agent-core/tools-mcp`：MCP 连接管理、传输适配、`ToolSource` 实现、tools/resources/prompts → `ToolDefinition`/`ToolResult` 归一）
- `packages/sdk/src/create-agent.ts`（接受 `toolSources` 注入，turn 边界聚合可见工具）
- `packages/sdk/src/defaults.ts`（空 ToolSource 兜底，沿用 Plan 002 兜底约定）
- `packages/core/src/tool-router.ts`（必要时扩展可见集聚合入口，仍纯函数）
- `apps/reference-cli`（示例 wiring：配置一个 MCP server）
- 对应 `__tests__/`（含 mock MCP server）

**Tasks**:
- [x] 新建 `@agent-core/tools-mcp` 包（依赖单向向下，type-import only 消费 core 的 `ToolSource` / `ToolDefinition` / `ToolResult` 接口类型，不值导入 core 实现）
- [x] 实现 MCP 连接层：stdio（子进程）与 HTTP-SSE 两种传输；连接生命周期（connect / disconnect / 断线检测）
- [x] 实现 `ToolSource.list()`：把在线 server 的 `tools` 映射为 `ToolDefinition`（input JSON Schema 透传为核心抽象 `JSONSchema`），统一声明 `mcp:<serverId>` 能力
- [x] `resources` / `prompts` 以受控工具暴露（如 `mcp_list_resources` / `mcp_read_resource` / `mcp_get_prompt`）
- [x] 实现 `onChange(cb)`：server 连接/断开/工具列表变更时通知；SDK 在 turn 边界重算可见集
- [x] 工具调用转发：把内核 `PendingToolCall` 转发给对应 server，返回归一为 `ToolResult`（双层：`modelContent` 精简 + `displayMetadata` 原始结构）；调用失败/超时/server 断线一律 `isError: true` 不抛异常
- [x] SDK：`createAgent` 接受 `toolSources`，与静态工具合并为可见候选集；turn 边界聚合 + 能力门控
- [x] 测试：mock MCP server，断言 (1) 工具进入可见集且可被选用 (2) 调用结果归一回喂 (3) server 缺席/断线时工具自动摘除 (4) 调用失败归一为 `isError`

**Acceptance Criteria**:
1. 配置一个 MCP server 后，其工具自动进入可见集、可被模型选用、结果归一回喂；**server 缺席（未连接/断线）时工具自动从可见集摘除**（复用能力门控，对应 roadmap M10 验收 1）。
2. MCP 工具调用失败 / server 超时 / 断线一律归一为 `isError: true` 的 `ToolResult` 回喂，**不抛异常中断主循环**。
3. `@agent-core/tools-mcp` 仅 `import type` 消费 core 接口（不值导入 core 实现）；`check-core-zero-deps` 仍通过。
4. SDK 不配置任何 ToolSource 时行为与 M7 一致（向后兼容）。

<!-- Backfill after execution:
**Reviewed**: <date> by reviewer
**Commit**: <hash> <subject>
-->

**Reviewed**: 2026-06-09 by reviewer (PASS)
**Commit**: 5a151af feat(plan-004): phase 1 - MCP 客户端实现 ToolSource 端口

---

### Phase 2: 工具可见集动态过滤（核心纯决策，守 ≤ ~20 上限）

**Goal**: 核心引入按作用域/模式 + 上限 N（默认 ~20）的可见集过滤纯函数，在能力门控之后裁剪，发生在 turn 边界；为后续大批工具落地先建闸。

**Files covered**:
- `packages/core/src/tool-router.ts`（或新增 `tool-visibility.ts`：作用域/上限裁剪纯函数）
- `packages/core/src/context-assembler.ts`（取工具处接入裁剪，保持静态前缀缓存友好）
- `packages/core/src/state.ts`（可见集作用域配置字段，若需要随 checkpoint 持久化）
- `packages/core/src/index.ts`（导出新纯函数）
- `packages/sdk/src/create-agent.ts`（注入作用域/上限配置）
- 对应 `__tests__/`

**Tasks**:
- [x] 实现纯函数 `filterByScope(tools, scopeConfig, limit)`：能力门控后，按作用域/模式 + 工具优先级裁剪到 ≤ N（默认 ~20），裁剪确定性（同输入同输出）
- [x] ContextAssembler 取工具处接入裁剪；裁剪发生在 turn 边界（工具集变更不破坏静态前缀缓存）
- [x] SDK：注入作用域/上限配置（缺省 = 全部可见 + 上限 ~20）
- [x] 测试：工具数 > N 时裁剪到 ≤ N；按作用域过滤正确；裁剪纯函数可重放（快照断言）
- [x] 回归：工具数 ≤ N 时行为与现状一致（向后兼容）

**Acceptance Criteria**:
1. 工具总量超阈值时按作用域/模式动态过滤，**默认可见 ≤ ~20**（对应 roadmap M10 验收 5、架构 §4.6）。
2. 裁剪为纯决策、可重放（同输入同输出，快照测试通过）；发生在 turn 边界，不破坏静态前缀缓存。
3. 工具数未超阈值时行为与现状一致（向后兼容）。

**Reviewed**: 2026-06-10 by reviewer (PASS)
**Commit**: e1570ab feat(plan-004): phase 2 - 工具可见集动态过滤（filterByScope 纯函数）

---

### Phase 3: 结构化编辑 + 扩展编辑格式（apply_patch / multi_edit / notebook / ast_edit）

**Goal**: 编辑工具域落地 `apply_patch`（diff）、`multi_edit`（单文件多处原子编辑）、`notebook` 编辑、`ast_edit`（AST/tree-sitter 结构化编辑）；沿用"先读后改 + 版本比对"门控；编辑格式按模型能力可选。

**Files covered**:
- `packages/tools/fs/`（扩展编辑工具）或新增 `packages/tools/edit/`（`@agent-core/tools-edit`）
- `packages/runtimes/node/src/`（tree-sitter 解析 adapter，按需）
- 对应 `__tests__/`

**Tasks**:
- [x] `apply_patch`：消费 unified diff，应用到文件；hunk 不匹配归一为 `isError` + 候选提示；继承先读后改 + 写回前版本比对
- [x] `multi_edit`：单文件多处 `str_replace` 原子应用（全成功才写回，任一失败整体回滚归一为 `isError`）
- [ ] `notebook` 编辑：定位/编辑 .ipynb cell（源码/输出），归一为结构化结果
- [ ] `ast_edit`：经 tree-sitter adapter 按符号/节点定位编辑（缺 adapter 时工具不可见，声明 `ast:edit` 能力）
- [x] 编辑格式选择：宿主可按模型能力暴露 `str_replace`（默认）/ `apply_patch` / `multi_edit`
- [x] 全部走 `defineTool`（zod）、声明 `requires` + `riskTier`（写类 `WRITE_LOW`/`WRITE_HIGH`）
- [x] 测试：apply_patch 命中/不匹配；multi_edit 原子性（部分失败整体回滚）；notebook cell 编辑；ast_edit 缺 adapter 不可见；先读后改/版本比对门控仍生效

**Acceptance Criteria**:
1. `apply_patch` 与 `multi_edit` 落地，编辑工具可按模型能力选择格式（对应 roadmap M10 验收 2）。
2. `multi_edit` 原子性：单处失败整体回滚并归一为 `isError`；`apply_patch` hunk 不匹配返回明确错误 + 候选，不抛异常。
3. 所有新编辑工具继承"未 `read_file`/版本过期拒绝编辑 + 写回前版本比对"门控；`ast_edit` 缺 tree-sitter adapter 时不可见。

**Reviewed**: 2026-06-10 by reviewer (PASS)
**Commit**: c6ed985 feat(plan-004): phase 3 - apply_patch + multi_edit 结构化编辑工具

---

### Phase 4: 代码智能（LSP 工具 + LSP runtime adapter）

**Goal**: `@agent-core/tools-code` + LSP runtime adapter 落地 —— `lsp_definition` / `lsp_references` / `lsp_rename` / `lsp_diagnostics` / `lsp_hover` 返回结构化结果；缺 adapter 时不可见。

**Files covered**:
- `packages/tools/code/`（新增 `@agent-core/tools-code`）
- `packages/runtimes/node/src/lsp.ts`（LSP 客户端 adapter：拉起/连接 language server，LSP 协议归一）
- 对应 `__tests__/`（mock LSP server）

**Tasks**:
- [x] LSP runtime adapter：启动/连接 language server（按语言配置），封装 LSP 请求（definition/references/rename/diagnostics/hover），声明 `lsp:query` 能力
- [x] 工具：`lsp_definition`（跳转）/ `lsp_references`（引用）/ `lsp_rename`（重命名，写类 → `WRITE_HIGH`）/ `lsp_diagnostics`（诊断）/ `lsp_hover`（hover），全走 `defineTool`，结果归一为结构化 `ToolResult`（位置/范围/符号列表）
- [x] 缺 LSP adapter（`lsp:query` 能力缺席）→ 工具自动从可见集摘除
- [x] LSP server 无响应/超时/不支持的语言 → 归一为 `isError` 不抛异常
- [x] 测试：mock LSP server 返回结构化结果；缺 adapter 不可见；超时归一为 `isError`

**Acceptance Criteria**:
1. LSP 工具返回**结构化结果**（跳转/引用/诊断），而非裸文本（对应 roadmap M10 验收 3）。
2. 缺 LSP adapter（能力缺席）时 LSP 工具从可见集摘除，模型不可见。
3. LSP server 超时/无响应归一为 `isError: true` 回喂，不抛异常。

**Reviewed**: 2026-06-10 by reviewer (PASS)
**Commit**: 58442e2 feat(plan-004): phase 4 - LSP 代码智能工具（tools-code）

---

### Phase 5: 测试-构建-Git 结构化工具

**Goal**: `@agent-core/tools-vcs`（git）与测试/构建工具落地，返回结构化 pass/fail / 失败用例 / diff / 提交摘要（非裸 bash），底层可经既有 `Shell` port，归一在工具层完成。

**Files covered**:
- `packages/tools/vcs/`（新增 `@agent-core/tools-vcs`：git 工具）
- `packages/tools/code/` 或新增测试/构建工具落点（`run_tests` / `build`）
- 对应 `__tests__/`

**Tasks**:
- [x] `git_status` / `git_diff`（`READ_ONLY`）/ `git_commit`（`WRITE_HIGH`）/ `git_push`（`IRREVERSIBLE`，触发 `ask`）：经 Shell port 执行，解析输出为结构化结果（变更文件 + 行数 / diff / 提交 hash）
- [x] `run_tests`：经 Shell 执行测试命令，解析为结构化 pass/fail 数 + 失败用例名 + 摘要（`modelContent` 精简，`displayMetadata` 原始）
- [x] `build`：经 Shell 执行构建，解析为成功/失败 + 错误摘要
- [x] 全走 `defineTool`，声明 `shell:exec` 能力（缺 Shell port 时不可见）+ 正确 `riskTier`；高风险触发 `PermissionPolicy` `ask`
- [x] 错误（命令失败/解析失败）归一为 `isError`，不抛异常；输出超量截断并声明
- [x] 测试：结构化 pass/fail 解析正确；`git_commit`/`git_push` 触发 `ask`；缺 Shell port 不可见

**Acceptance Criteria**:
1. 测试/构建/Git 工具返回**结构化 pass/fail / diff / 提交摘要**（非裸 bash 文本，对应 roadmap WS-5）。
2. `git_commit` / `git_push` 等高风险操作经 `PermissionPolicy` 触发 `ask`；缺 `Shell` port 时工具不可见。
3. 命令失败 / 输出解析失败归一为 `isError` 回喂；超量输出截断并声明，不抛异常。

**Reviewed**: 2026-06-10 by reviewer (PASS)
**Commit**: e9f91cd feat(plan-004): phase 5 - 测试/构建/Git 结构化工具（tools-vcs）

---

### Phase 6: 外设与数据工具（browser / db / http / 文件格式 / ask_user）

**Goal**: 落地 browser/computer-use、db、结构化 http、文件格式（PDF/docx/xlsx/image）、`ask_user` 工具及对应 adapter；各自 capability 门控，缺 adapter 自动不可见。

**Files covered**:
- `packages/tools/browser/`（`@agent-core/tools-browser`：browser/computer-use）
- `packages/tools/data/`（`@agent-core/tools-data`：db / http）
- `packages/tools/document/`（`@agent-core/tools-document`：PDF/docx/xlsx/image 读取）或扩展 `tools-fs` 的 `read_file` 多模态
- `packages/tools/ask/`（`@agent-core/tools-ask`：`ask_user`）
- `packages/runtimes/node/src/{browser.ts,database.ts,document-parser.ts}`（对应 adapter）
- 对应 `__tests__/`

**Tasks**:
- [x] browser/computer-use：声明 `browser:control` 能力 + 经 Browser adapter（导航/点击/输入/截图/读取页面）；高风险动作偏高 `riskTier`，可 `ask`；缺 adapter 不可见
- [ ] db：`db_query`（`READ_ONLY`，`db:query`）/ `db_exec`（`WRITE_HIGH`，`db:exec`）经 Database adapter；连接串经 `Secrets` 端口解析（M8 契约 + M10 兜底）
- [x] http：结构化 HTTP 工具（自定义 method/headers/body）复用既有 `Network` port，声明 `network`
- [ ] 文件格式：PDF/docx/xlsx/image 经解析 adapter 归一为结构化文本 / image block（扩展 `read_file` 多模态或独立 `read_document`）
- [x] `ask_user`：无外部能力，经 `ApprovalGate`/`EventSink` 向宿主提问，回答作为 input 回喂归一为 `ToolResult`；宿主无交互能力时归一为 `isError`
- [x] 全走 `defineTool`，声明 `requires` + `riskTier`；各工具错误归一为 `isError` 不抛异常
- [x] 测试：browser 经 capability 门控、缺 adapter 不可见；db 凭据经 Secrets 解析；http 经 Network；文件格式归一为结构化；`ask_user` 回喂

**Acceptance Criteria**:
1. browser 工具经 **capability 门控；缺 adapter 时不可见**（对应 roadmap M10 验收 4）。
2. db / http / 文件格式 / `ask_user` 工具各按 capability 门控落地，缺对应 port/adapter 时自动从可见集摘除。
3. 所有工具错误（浏览器超时 / SQL 报错 / 文件解析失败 / 宿主无交互能力）归一为 `isError: true` 回喂，不抛异常；db 凭据经 `Secrets` 端口解析（不明文）。

**Reviewed**: 2026-06-10 by reviewer (PASS)

---

## 6. Risks and mitigations

| Risk | Impact | Mitigation |
|---|---|---|
| MCP server 不可信内容（prompt 注入）经工具结果回喂模型 | 提示注入 / 越权 | M10 标注为已知风险，结果照常归一回喂；防注入 guardrails 归 M11；`riskTier` + HITL 兜底高风险 MCP 工具 |
| MCP / LSP / browser 的 I/O 与连接生命周期复杂，易引入隐式副作用渗入核心 | 破坏纯度/可重放 | 所有 I/O、连接、计时全在 adapter 层；核心只见归一化 `ToolResult`；core lint 纯度规则 + 零依赖校验把关 |
| 工具总量激增（MCP 动态 + 内置多包）拖垮模型工具选择 | 选择质量下降、token 膨胀 | Phase 2 先建可见集动态过滤闸（≤ ~20）；裁剪发生在 turn 边界保缓存 |
| MCP 工具不经 `defineTool`（JSON Schema 而非 zod）绕过运行时校验 | 入参不合法导致 adapter 崩溃 | adapter 内对 MCP 工具入参按透传的 JSON Schema 校验，失败归一为 `isError`；本仓自研工具仍一律走 `defineTool` |
| 新编辑格式（apply_patch/multi_edit）绕过先读后改/版本比对门控 | 盲写 / 并发覆盖 | 所有新编辑工具强制继承既有门控；multi_edit 原子回滚；测试作回归门 |
| server 缺席/断线判定与可见集重算时机错位 | 工具该摘未摘 / turn 中途变更破坏缓存 | 复用能力门控（`mcp:<serverId>` 能力随连接增删）；可见集重算固定在 turn 边界 |
| db 凭据明文进日志/状态 | 凭据泄露 | 连接串经 `Secrets` 端口解析，不入 `displayMetadata` / 状态；真实金库归 M11 |
| 与 M13 插件系统 / M11 沙箱职责重叠返工 | 范围蔓延 / 重复实现 | §4.7 边界已显式划清：M10 只做 ToolSource adapter（MCP 客户端）+ 能力门控 + riskTier；插件框架归 M13、隔离硬化归 M11，且复用本 Plan 接线点 |
