# Plan 008 — M14 宿主与形态

> **Status**: Draft
> **Owner**: TBD
> **Created**: 2026-06-09
> **Depends on**: 演进路线图 [docs/roadmap.md](../docs/roadmap.md) M14（WS-10）；架构设计 [docs/pure-agent-core.md](../docs/pure-agent-core.md)（尤其 §9 可移植性矩阵）；Plan 001（M1–M7 已交付：SDK run/stream/resume 门面、SessionStore 合同测试套件、参考 CLI 仅 wiring）；Plan 002（M8 已立 9 个纯类型端口契约，本 Plan 消费其中 `ToolSource` / `Sandbox` / `Secrets` / `PolicyEngine`）
> **Target area**: `packages/stores/{sqlite,postgres}/`、`packages/runtimes/{browser,edge}/`、`apps/{headless-server,mcp-server,ide-extension,github-action,chat-adapter}/`（各宿主仅 wiring，**`packages/core/` 零改动**）

## 1. 背景

### 1.1 问题陈述

M1–M7 交付了纯函数内核 + SDK（run/stream/resume）门面 + 参考 CLI（仅 wiring），M8（Plan 002）又立了 9 个纯类型端口契约。架构设计 [pure-agent-core.md](../docs/pure-agent-core.md) §9 列出了 7 类宿主（CLI / HTTP 服务 / 桌面 / 浏览器 / Edge / 嵌入库 / MCP server）的可移植性矩阵——"横行换 adapter，竖列（core + 工具包 + 决策逻辑）完全不动"。但当前仅 CLI 宿主与 memory/file 两个 store 落地，矩阵的其余横行尚是承诺而非证据。

M14 是路线图最后一个里程碑（P2），主题是**兑现"高可移植"不变量**：把同一核心铺到多种宿主与持久化后端，并以 **browser/Edge runtime 终证可移植性承诺**（`@agent-core/core` 包零改动跑通）。本 Plan 落地 M14 的全部能力：

- **持久化形态**：`store-sqlite`、`store-postgres`（须过既有 SessionStore 合同测试）。
- **服务形态**：headless server（HTTP/SSE/WS，支持 run/stream/resume）。
- **可移植终证**：browser/Edge runtime（OPFS / virtual-fs / 对象存储，实现 FileSystem 等 port 的浏览器/边缘 adapter）。
- **互操作形态**：把 agent **暴露为 MCP server**，可被其它 agent 作为工具调用。
- **集成形态**：IDE 集成（VS Code / JetBrains）、CI/CD 宿主（GitHub Action）、chat（Slack/Discord）适配。

全程守铁律：**所有宿主仅做 wiring（选 adapter + 注入能力 + 订阅事件），核心包零改动**；新 store 复用 core `testing/store-contract` 合同测试套件；新 runtime 实现既有 port 接口；EventSink 适配 SSE/WS/IPC。

### 1.2 现状审计

| 维度 | 当前实现 | 目标状态 |
|---|---|---|
| SessionStore | `store-memory`（Map）、`store-file`（JSON 文件）；二者过 `runStoreContractTests` 合同测试 | +`store-sqlite`、`store-postgres`，**同一合同测试套件全绿**，覆盖单机持久化与多副本/并发服务场景 |
| 宿主形态 | 仅 `apps/reference-cli`（stdout 渲染、REPL、Node adapter） | +headless server（HTTP/SSE/WS）、MCP server、IDE 扩展、GitHub Action、chat 适配——均仅 wiring |
| EventSink 形态 | 仅 stdout 渲染（`createRenderingEventSink`） | +SSE / WebSocket / IPC / MCP 协议适配，复用同一 `emit({type,data})` 契约 |
| runtime adapter | 仅 `runtime-node`（FileSystem/Shell/Network/Tokenizer/ApprovalGate） | +`runtime-browser`（OPFS / virtual-fs / fetch-代理 Network；Shell 缺席）、`runtime-edge`（对象存储 fs / fetch；Shell 缺席） |
| 可移植性证据 | §9 矩阵中仅 "CLI 工具" 横行有落地证据 | 矩阵 "HTTP 服务"/"浏览器"/"Edge"/"MCP server" 横行均有可运行宿主 + 验收，**core 零改动**得到 e2e 证明 |
| 对外互操作 | agent 只能被本仓宿主调用 | agent 作为 MCP server 暴露 run（及流式），可被任意 MCP 客户端当工具调用 |

### 1.3 设计目标

1. **核心零改动**：本 Plan 不触碰 `packages/core/`，所有能力靠"新增 store / runtime adapter / 宿主 app"实现；以 git diff 不含 `packages/core/**` 为硬验收。
2. **合同复用**：新 store 一律消费 core `testing/store-contract` 的 `runStoreContractTests`，不另写一套断言，保证行为与 memory/file 严格一致。
3. **门面单一**：所有宿主统一经 `@agent-core/sdk` 的 `createAgent` + run/stream/resume，宿主层不重新实现编排，只做协议转换（HTTP/WS/MCP/IPC ↔ SDK 调用 + EventSink）。
4. **形态可移植**：browser/Edge runtime 实现既有 `FileSystem` / `Network` / `Tokenizer` 等 port 接口（缺席能力经能力门控自动摘除工具），不引入 Node 专属 API 进可移植 adapter。
5. **边界清晰**：只做 MCP **server** 暴露（客户端归 Plan 004 M10）；不新增端口类型（归 Plan 002 M8）；不实现具体工具（归 Plan 004 M10）。

## 2. Goals

1. `store-sqlite` 与 `store-postgres` 落地，二者**通过既有 `runStoreContractTests` 合同测试套件**（与 memory/file 同一断言），各自补持久化/并发特化测试。
2. headless server 落地：HTTP 端点驱动 `run`、SSE/WS 通道驱动 `stream`、resume 端点驱动 HITL 续跑；**SSE 与 WS 两种流式传输都经 EventSink 适配输出事件**。
3. `runtime-browser` 落地：实现 `FileSystem`（OPFS / virtual-fs）+ `Network`（fetch 代理）+ `Tokenizer` adapter，**在浏览器环境跑通核心一轮对话，`@agent-core/core` 包零改动**（可移植性最终证明）。
4. `runtime-edge` 落地：实现对象存储 `FileSystem` + fetch `Network` adapter，在 Edge/Worker 环境跑通核心（Shell 缺席经门控摘除）。
5. agent **暴露为 MCP server**：把一次 agent run 暴露为一个 MCP tool，可被其它 MCP 客户端发现并作为工具调用，结果与流式事件经 MCP 协议回传。
6. IDE 集成（VS Code 扩展，JetBrains 留 IPC 契约骨架）、GitHub Action（CI 宿主）、chat 适配（Slack/Discord）落地为薄 wiring 宿主，复用 headless server 或 SDK 门面。
7. 全程 `pnpm turbo run typecheck lint test` 通过 + `check-core-zero-deps` 通过 + **git diff 不含 `packages/core/**`**。

## 3. Non-Goals

1. **不**实现 MCP **客户端**（接外部 MCP server 的工具/资源/prompt 进可见集，归 Plan 004 M10）；本 Plan 只做 MCP **server** 暴露方向。
2. **不**新增/修改任何端口类型定义（9 个端口契约由 Plan 002 M8 owns；如发现契约不足，记风险回流 M8，不在本 Plan 改核心）。
3. **不**实现具体工具（fs/shell/web/code-intel 等工具归 Plan 004 M10）；本 Plan 只提供 runtime adapter（port 实现），工具沿用既有包经能力门控装配。
4. **不**实现真实容器/microVM 沙箱（Sandbox 真实 adapter 归 Plan 005 M11）；headless/edge 宿主消费既有 `Sandbox`/`PolicyEngine` 端口的兜底即可。
5. **不**实现鉴权/计费/多租户的生产级安全体系；headless server 仅做最小 token 校验骨架 + 留扩展点，生产硬化非本 Plan 范围。
6. **不**改动现有 store-memory / store-file / runtime-node / sdk 对外行为（仅在必要处为 SDK 增加可选 store 工厂导出，不破坏既有签名）。

## 4. Key decisions

### 4.1 新 store 复用合同测试，差异仅在持久化语义

**决策**：`store-sqlite` / `store-postgres` 的对外接口严格实现 `SessionStore`（`save` / `load` / `list`），测试**先**调用 `runStoreContractTests(createStore)` 复用 memory/file 同一套断言，**再**补各自特化测试（sqlite：文件持久化跨实例可见、WAL 并发读；postgres：连接池、并发 upsert 幂等、`list` 大表分页）。`save` 用 upsert（`INSERT ... ON CONFLICT` / `INSERT OR REPLACE`）以满足合同的"同 id 覆盖"语义。

**理由**：合同测试是"换 store 不改行为"的护栏；先过合同再谈特化，保证任意宿主可无差别替换 store。upsert 直接对齐合同里 `overwrites existing snapshot with same id`。

> **跨 Plan 接缝（checkpoint 历史）**：M12（Plan 006）会把"按 `sessionId#seq` 多 key 追加式 checkpoint 历史"固化进 `runStoreContractTests`。本 Plan 的 `store-sqlite` / `store-postgres` **须通过该扩展后的同一合同**（自动获得时间旅行所需的历史能力），而非各自另造历史机制。若 M12 先于 M14 落地，M14 直接面向扩展后的合同实现；若 M14 先行，则 M12 落地时这两个新 store 随合同更新补测。

### 4.2 持久化层依赖隔离在 store 包内，不渗入 core / sdk

**决策**：`better-sqlite3`（或 `node:sqlite`）与 `pg` 等第三方驱动**只**出现在对应 store 包的 `dependencies`，core 仍零依赖、sdk 不强依赖任何具体 store（仅 `store-memory` 作默认兜底，sqlite/postgres 由宿主按需注入 `sessionStore`）。store 包以 `import type` 消费 core 的 `SessionStore` / `SessionSnapshot`（type-import only 铁律）。

**理由**：守"依赖单向向下"与"核心零依赖"；让重型驱动只在真正用到的宿主进程被加载，浏览器/Edge 宿主不被 Node 原生模块污染。

### 4.3 headless server：HTTP=run/resume，SSE+WS=stream，EventSink 即协议适配器

**决策**：headless server 是一个薄 HTTP app，把 `createAgent` 实例的三姿势映射为端点：`POST /run`（一次性，返回最终 state）、`POST /resume`（HITL 续跑）、`GET /stream`（SSE）与 `GET /ws`（WebSocket）订阅同一次 turn 的事件。流式实现的核心是**两个 EventSink adapter**——`createSseEventSink(res)` 与 `createWsEventSink(socket)`——各自把 `emit({type,data})` 序列化为 SSE `data:` 帧 / WS message，注入 `createAgent({ eventSink })`。会话状态经注入的 `SessionStore`（sqlite/postgres）持久化，使 resume 可跨连接/跨进程。

**理由**：SDK 门面已提供 run/stream/resume，宿主只需做"协议 ↔ 调用 + 事件序列化"，零核心改动；EventSink 的 `{type,data}` 契约天然适配 SSE/WS/IPC/MCP，正是 §11"流式传输无关"的兑现。

### 4.4 browser/Edge runtime：实现既有 port，缺席能力靠门控摘除

**决策**：`runtime-browser` 实现 `FileSystem`（优先 OPFS `navigator.storage.getDirectory()`，回退纯内存 virtual-fs 以适配无 OPFS 环境）、`Network`（包装 `fetch`，受 CORS/代理约束）、`Tokenizer`（轻量字符估算或 WASM 分词）；**不**提供 `Shell`（浏览器无 shell）。`runtime-edge` 实现对象存储 `FileSystem`（如 R2/S3/KV 抽象）+ fetch `Network`，同样无 Shell。宿主装配时不传 `shell`，shell 工具经既有能力门控自动从可见集摘除——无需任何核心改动。可移植性 e2e：用 `mock-model-port` + browser runtime 在浏览器（或 jsdom/`happy-dom` 模拟 + 真实 OPFS polyfill）跑通核心一轮，断言 `packages/core` 未改一行。

**理由**：这正是"换 adapter 不动核心"的最终证明；缺席能力交给已存在的能力门控（ToolRouter）处理，不必在宿主或核心做特判。

### 4.5 暴露为 MCP server：一次 agent run = 一个 MCP tool

**决策**：`apps/mcp-server` 启一个 MCP server（stdio + 可选 HTTP/SSE 传输），注册一个 `agent_run`（及可选 `agent_stream`）tool：入参为用户消息 + 可选 sessionId，handler 内部调用 `createAgent(...).run(...)`，把最终回复作为 MCP tool 结果返回；流式进度经 MCP 的 progress/notification 通道转发 EventSink 事件。这是**对外暴露方向**，与 Plan 004 的 MCP 客户端（对内消费方向）正交。

**理由**：路线图 M14 验收明确要求"agent 暴露为 MCP server，可被其它 agent 作为工具调用"；以 SDK 门面为唯一执行入口，宿主只做 MCP 协议 ↔ run 适配，保持零核心改动并避免与 M10 客户端职责重叠。

### 4.6 IDE / CI / chat 宿主：尽量复用 headless server，避免重复 wiring

**决策**：IDE 扩展（VS Code）与 chat 适配（Slack/Discord）默认**作为 headless server 的客户端**（HTTP/SSE/WS 调用），而非各自重新 `createAgent`；仅在 IDE 需要本地直连时提供"嵌入 SDK"模式。GitHub Action 作为一次性 CI 宿主直接用 SDK 跑 `run`（非交互、auto-policy、结果写入 PR/输出）。JetBrains 本期只落 IPC 契约骨架（与 VS Code 共享事件协议），完整实现留后续。

**理由**：headless server 一旦稳，IDE/chat 退化为"协议客户端 + 渲染"，把 wiring 收敛到一处，最小化重复与维护面；CI 是无状态一次性场景，直连 SDK 最简。

### 与其它 Plan 的边界

> 本 Plan（008）owns **WS-10 宿主与形态**。为防与兄弟 Plan 重叠/冲突，明确以下边界（边界图见各 Plan §背景）：

| 关注点 | 归属 | 本 Plan（008 / M14）的处理 |
|---|---|---|
| 9 个端口类型定义（ToolSource / MemoryStore / Embedder / Telemetry / Cache / Sandbox / Secrets / Scheduler / PolicyEngine） | **Plan 002 / M8** | **只消费/实现**这些端口，**绝不重新定义**端口类型；契约不足则记风险回流 M8 |
| MCP **客户端**（接外部 MCP server 的工具/资源进可见集） | **Plan 004 / M10** | 不做；本 Plan 只做 MCP **server** 暴露（对外被调用方向） |
| 具体工具（fs/shell/web/LSP/AST/browser-use 等工具实现） | **Plan 004 / M10** | 不做；本 Plan 只提供 runtime **adapter**（port 实现），工具沿用既有包经能力门控 |
| 真实沙箱（容器/microVM/seatbelt）、guardrails、egress 管控 | **Plan 005 / M11** | 不做真实沙箱；headless/edge 消费既有 `Sandbox`/`Secrets`/`PolicyEngine` 端口兜底 |
| OTel tracing / 指标 / 审计日志（Telemetry 端口的真实 adapter） | **Plan 006 / M12** | 不做真实 Telemetry；宿主仅经 EventSink 透传事件（面向用户/UI），Telemetry 留 M12 |
| 插件系统 / hooks / 声明式 agent 规格 / 分层配置 | **Plan 007 / M13** | 不做；宿主用静态 wiring 装配，不引入插件加载机制 |
| 原生 Anthropic / 多 provider / 缓存 / RAG / 记忆 | **Plan 003 / M9** | 不做；宿主沿用既有 provider-openai + mock，store 仅做 SessionStore（非 MemoryStore 向量记忆） |

边界一句话：**M14 只换"外壳与持久化后端"，不碰"端口契约（M8）、工具与 MCP 客户端（M10）、真实沙箱/可观测/插件（M11–M13）、模型与记忆（M9）"。**

## 5. 实现计划

> Phase 1（新 store）最低风险且为服务宿主提供持久化底座，先做；Phase 2（headless server）依赖 Phase 1 的 store 做跨连接 resume，是 IDE/chat 的公共底座；Phase 3（browser/Edge runtime）是可移植性终证，独立于服务链路；Phase 4（MCP server 暴露）依赖稳定的 SDK 门面；Phase 5（IDE/CI/chat 集成）依赖 Phase 2 的 server。严格串行、逐 Phase review + 单独 commit。

### Phase 1: 持久化形态 — store-sqlite / store-postgres（过合同测试）

**Goal**: 新增 `store-sqlite`、`store-postgres` 两个包，各实现 `SessionStore`，**通过既有 `runStoreContractTests` 合同测试套件**，并补持久化/并发特化测试；core / sdk 不强依赖具体驱动。

**Files covered**:
- `packages/stores/sqlite/src/index.ts`（`createStore(opts)` → `SessionStore`，driver: `better-sqlite3` 或 `node:sqlite`）
- `packages/stores/sqlite/package.json`（包名 `@agent-core/store-sqlite`，依赖隔离驱动）
- `packages/stores/postgres/src/index.ts`（`createStore(opts)` → `SessionStore`，driver: `pg`，连接池）
- `packages/stores/postgres/package.json`（包名 `@agent-core/store-postgres`）
- `packages/stores/{sqlite,postgres}/src/__tests__/*.test.ts`（复用 `runStoreContractTests` + 特化）
- `packages/sdk/src/defaults.ts`（可选导出 store 工厂便利封装，**不**改默认兜底，仍是 memory）

**Tasks**:
- [ ] `store-sqlite`：建表（`sessions(id PRIMARY KEY, state JSON, created_at INTEGER)`），`save` 用 `INSERT OR REPLACE`（满足合同覆盖语义），`load`/`list` 反序列化 `AgentState`；`import type { SessionStore, SessionSnapshot }` from core
- [ ] `store-postgres`：建表（`sessions(id TEXT PRIMARY KEY, state JSONB, created_at BIGINT)`），`save` 用 `INSERT ... ON CONFLICT (id) DO UPDATE`，连接池经 opts 注入或自建
- [ ] 两包测试：`describe` 内调用 `runStoreContractTests(() => createStore(...))` 复用合同断言
- [ ] sqlite 特化测试：跨 store 实例（同文件）`save` 后另一实例 `load` 可见；空目录自动建库
- [ ] postgres 特化测试：并发 `save` 同 id 幂等收敛；`list` 返回全部；连接错误归一不 crash（用 `pg-mem` 或测试容器，CI 无库时跳过并标注）
- [ ] package.json：驱动只进对应 store 包 `dependencies`；core/sdk 不新增对它们的强依赖

**Acceptance Criteria**:
1. `store-sqlite` 与 `store-postgres` **均通过 `runStoreContractTests`**（与 memory/file 同一套断言全绿）。
2. sqlite 持久化跨实例可见、postgres 并发 upsert 幂等，各有特化测试覆盖。
3. `check-core-zero-deps` 仍通过；core/sdk 未新增对 `better-sqlite3`/`pg` 的强依赖；store 包以 `import type` 消费 core。
4. git diff 不含 `packages/core/**`。

<!-- Backfill after execution:
**Reviewed**: <date> by reviewer
**Commit**: <hash> <subject>
-->

---

### Phase 2: 服务形态 — headless server（HTTP + SSE + WS，run/stream/resume）

**Goal**: 落地 headless server，HTTP 驱动 run/resume、SSE 与 WS 两种通道驱动 stream，会话经注入的 sqlite/postgres store 持久化，支持跨连接 resume；纯 wiring，核心零改动。

**Files covered**:
- `apps/headless-server/src/server.ts`（HTTP 路由：`POST /run`、`POST /resume`、`GET /stream`(SSE)、`GET /ws`(WS)）
- `apps/headless-server/src/event-sinks.ts`（`createSseEventSink(res)` / `createWsEventSink(socket)`，把 `emit({type,data})` → SSE 帧 / WS message）
- `apps/headless-server/src/wiring.ts`（`createAgent` 装配：provider-openai/mock + runtime-node adapter + 注入 store）
- `apps/headless-server/package.json`（依赖 sdk + 选定 store + provider；HTTP/WS 库如 `ws`）
- `apps/headless-server/src/__tests__/*.test.ts`（端点 + 流式 e2e，用 mock-model-port）

**Tasks**:
- [ ] `POST /run`：解析 body（message + 可选 sessionId）→ `agent.run(input)` → 返回最终 `state`（JSON）
- [ ] `GET /stream`(SSE)：`createSseEventSink(res)` 注入 `createAgent`，转发 `agent.stream(input)` 事件为 `data: {json}\n\n` 帧；连接断开时 abort
- [ ] `GET /ws`(WS)：`createWsEventSink(socket)` 注入，转发同一事件流为 WS message；客户端关闭时 abort
- [ ] `POST /resume`：`{ sessionId, decision }` → `agent.resume(...)`（从注入的持久化 store 加载，支持跨连接/跨进程续跑）
- [ ] wiring：服务进程注入 `store-sqlite`/`store-postgres`（非默认内存）使 resume 跨连接可用；policy 走 auto/PolicyEngine 兜底
- [ ] e2e 测试：mock-model-port 下 `POST /run` 返回最终 state；SSE 与 WS 各收到完整事件序列；HITL 暂停后 `POST /resume` 续跑到 done

**Acceptance Criteria**:
1. **headless server 经 SSE 与 WS 两种流式传输输出事件**，且 `POST /run`、`POST /resume`、`GET /stream`/`GET /ws` 覆盖 run/stream/resume 三姿势。
2. HITL `ask` 暂停后，经 `POST /resume`（从持久化 store 加载）能跨连接续跑到 `done`。
3. server 仅做协议 ↔ SDK 调用 + EventSink 序列化；git diff 不含 `packages/core/**`。
4. `typecheck lint test` 全绿。

<!-- Backfill -->

---

### Phase 3: 可移植终证 — runtime-browser / runtime-edge（core 零改动跑通）

**Goal**: 新增 `runtime-browser`（OPFS/virtual-fs FileSystem + fetch Network + Tokenizer，无 Shell）与 `runtime-edge`（对象存储 FileSystem + fetch Network，无 Shell），在浏览器/Edge 环境跑通核心一轮对话，**`@agent-core/core` 包零改动**——可移植性的最终证明。

**Files covered**:
- `packages/runtimes/browser/src/{filesystem,network,tokenizer,index}.ts`（实现既有 `FileSystem`/`Network`/`Tokenizer` port）
- `packages/runtimes/browser/package.json`（包名 `@agent-core/runtime-browser`，无 `node:*` 依赖）
- `packages/runtimes/edge/src/{filesystem,network,index}.ts`（对象存储 FileSystem + fetch Network）
- `packages/runtimes/edge/package.json`（包名 `@agent-core/runtime-edge`）
- `packages/runtimes/{browser,edge}/src/__tests__/*.test.ts`（port 行为 + 核心 e2e）

**Tasks**:
- [ ] `runtime-browser` FileSystem：OPFS（`navigator.storage.getDirectory()`）读/写/stat/list，回退纯内存 virtual-fs（无 OPFS 时）；实现 `glob`/`grep` 在 virtual-fs 上的纯 JS 版本
- [ ] `runtime-browser` Network：包装全局 `fetch`，映射 `NetworkRequest`/`NetworkResponse`；Tokenizer：字符估算（或 WASM 分词）实现 `count`
- [ ] `runtime-edge` FileSystem：抽象对象存储（put/get/list 前缀）映射 `FileSystem`；Network：fetch 包装；二者不 import `node:*`
- [ ] 可移植 e2e（browser）：`mock-model-port` + `runtime-browser` adapter 经 `createAgent`（不传 `shell`）在 jsdom/happy-dom + OPFS polyfill（或真实浏览器 harness）跑通含 read/write 工具的一轮对话
- [ ] 可移植 e2e（edge）：同上用 `runtime-edge` 在 Worker 风格运行时（或 `@cloudflare/workers-types` mock）跑通
- [ ] 缺席能力验证：未注入 `shell` 时 bash 工具不在可见集（能力门控自动摘除），无需核心特判
- [ ] **零改动断言**：在 e2e 测试或 CI 脚本中校验本 Phase 提交的 git diff 不含 `packages/core/**`

**Acceptance Criteria**:
1. **`runtime-browser` 在浏览器环境跑通核心一轮对话（read/write 经 OPFS/virtual-fs），`@agent-core/core` 包零改动**——可移植性最终证明。
2. `runtime-edge` 在 Edge/Worker 运行时跑通核心；二者均无 `node:*` import、Shell 缺席经门控自动摘除。
3. 两 runtime 以 `import type` 消费 core port 接口；`check-core-zero-deps` 通过。
4. git diff 不含 `packages/core/**`（以脚本/测试断言）。

<!-- Backfill -->

---

### Phase 4: 互操作形态 — 暴露为 MCP server

**Goal**: 把 agent 暴露为 MCP server，注册 `agent_run`（及可选 `agent_stream`）tool，可被任意 MCP 客户端发现并作为工具调用；流式进度经 MCP notification 转发 EventSink 事件。纯 wiring，核心零改动。

**Files covered**:
- `apps/mcp-server/src/server.ts`（MCP server：stdio + 可选 HTTP/SSE 传输，注册 `agent_run` tool）
- `apps/mcp-server/src/event-sink.ts`（`createMcpEventSink(notify)`：`emit({type,data})` → MCP progress/notification）
- `apps/mcp-server/src/wiring.ts`（`createAgent` 装配 + 注入 store）
- `apps/mcp-server/package.json`（依赖 sdk + `@modelcontextprotocol/sdk` server + provider/runtime）
- `apps/mcp-server/src/__tests__/*.test.ts`（MCP 客户端 ↔ server e2e，mock-model-port）

**Tasks**:
- [ ] MCP server：声明 server 元信息，注册 `agent_run` tool（inputSchema：`{ message: string, sessionId?: string }`），handler 调 `agent.run(input)` 返回最终回复文本
- [ ] 可选 `agent_stream`：经 MCP progress/notification 把 `createMcpEventSink` 收到的事件流式回传
- [ ] EventSink 适配：`createMcpEventSink(notify)` 把 `{type,data}` 序列化为 MCP 通知，注入 `createAgent({ eventSink })`
- [ ] wiring：注入持久化 store 以支持多次调用间的 sessionId 续跑
- [ ] e2e：用 MCP SDK 的 in-memory client 连本 server，`callTool("agent_run", {...})` 收到正确结果；流式变体收到事件序列

**Acceptance Criteria**:
1. **agent 暴露为 MCP server，`agent_run` tool 可被 MCP 客户端发现并调用**，返回 agent 最终回复——满足"可被其它 agent 作为工具调用"。
2. 流式变体经 MCP notification 转发 EventSink 事件序列。
3. 仅做 MCP 协议 ↔ SDK 调用适配（**不**实现 MCP 客户端方向，不与 Plan 004 重叠）；git diff 不含 `packages/core/**`。
4. `typecheck lint test` 全绿。

<!-- Backfill -->

---

### Phase 5: 集成形态 — IDE（VS Code）/ CI（GitHub Action）/ chat（Slack/Discord）

**Goal**: 落地 VS Code 扩展、GitHub Action、Slack/Discord chat 适配三个薄 wiring 宿主：IDE/chat 默认作为 headless server 客户端，CI 直连 SDK 一次性 run；JetBrains 留 IPC 契约骨架。核心与 SDK 零改动。

**Files covered**:
- `apps/ide-extension/src/extension.ts`（VS Code 扩展：命令 → 调 headless server 或嵌入 SDK，事件渲染到 output/webview）
- `apps/ide-extension/src/ipc-contract.ts`（与 JetBrains 共享的事件/请求 IPC 契约骨架）
- `apps/github-action/src/main.ts`（CI 宿主：读 action input → `agent.run` 非交互 + auto-policy → 写输出/PR 评论）
- `apps/github-action/action.yml`
- `apps/chat-adapter/src/{slack,discord}.ts`（消息事件 ↔ headless server run/stream，EventSink → chat 消息）
- 各 app `package.json` + `src/__tests__/*.test.ts`

**Tasks**:
- [ ] VS Code 扩展：注册命令，把用户输入经 HTTP/SSE 转发到 headless server（或嵌入模式直连 SDK），事件渲染到 OutputChannel/webview；HITL `ask` 弹 VS Code modal 映射为 `resume`
- [ ] IPC 契约骨架：抽出 IDE ↔ agent 的请求/事件类型，VS Code 实现之、JetBrains 仅占位实现（标注 TODO 留后续）
- [ ] GitHub Action：解析 inputs（prompt/model/cwd），`createAgent` auto-policy 跑 `run`，最终回复写入 `$GITHUB_OUTPUT` / PR 评论；非交互（approvalGate auto-allow 或 deny-写）
- [ ] chat 适配：Slack/Discord 收消息 → 调 headless server `stream`，EventSink 事件聚合为 chat 回复（流式编辑或分段）；HITL 经交互按钮映射 resume
- [ ] 各宿主 smoke 测试：mock headless server / mock SDK 下，输入 → 期望输出渲染；CI 在无真实 token 时跳过外呼并标注

**Acceptance Criteria**:
1. VS Code 扩展经 headless server（或嵌入 SDK）跑通一轮对话并渲染事件，HITL 经 modal → resume 续跑。
2. GitHub Action 在 CI 一次性非交互 `run` 跑通，最终回复写入 action 输出。
3. Slack/Discord 适配把 headless server 事件流渲染为 chat 回复；JetBrains 留 IPC 契约骨架（标注后续）。
4. 三宿主均为薄 wiring，复用 Phase 2 server / SDK 门面；git diff 不含 `packages/core/**`；`typecheck lint test` 全绿。

<!-- Backfill -->

---

## 6. Risks and mitigations

| Risk | Impact | Mitigation |
|---|---|---|
| 新 store 未真正过合同测试（仅自写部分断言） | "换 store 不改行为"承诺落空，宿主替换 store 引入隐性 bug | 测试**必须**调用 core `runStoreContractTests`，再补特化；CI 把合同测试作为 store 包硬门 |
| 第三方驱动（better-sqlite3/pg）渗入 core/sdk 强依赖 | 破坏核心零依赖与可移植（浏览器/Edge 被 Node 原生模块污染） | 驱动只进对应 store 包 `dependencies`；store 包 `import type` 消费 core；`check-core-zero-deps` 兜底；sdk 默认仍 memory |
| 宿主层悄悄改核心以"图方便" | 破坏可移植性的最终证明、违反 M14 立意 | 每 Phase 验收含"git diff 不含 `packages/core/**`"硬检查；可移植 e2e 在 CI 断言核心未改 |
| browser runtime 引入 `node:*` 或浏览器缺 OPFS | 浏览器/Edge 跑不起来，可移植终证失败 | `runtime-browser`/`edge` 禁 `node:*`（lint 规则）；OPFS 不可用时回退纯内存 virtual-fs；e2e 覆盖两路径 |
| SSE/WS 流式与 EventSink 契约不匹配（事件丢失/乱序） | 流式输出不可靠，IDE/chat 渲染错乱 | 复用 SDK `stream()` + 单一 `{type,data}` 契约，sink 只做序列化；e2e 断言完整事件序列与顺序 |
| MCP server 暴露与 Plan 004 MCP 客户端职责混淆 | 重复实现、边界冲突 | 本 Plan 严格只做 server 暴露（被调用方向）；客户端方向记入 Non-Goals + 边界表，引用 Plan 004 |
| 端口契约（M8）不足以支撑某宿主（如 PolicyEngine 字段缺） | 诱使在本 Plan 改核心端口类型 | 不在本 Plan 改端口；记风险回流 Plan 002 M8 调整契约，本 Plan 先用兜底实现绕行 |
| headless server 缺鉴权被当生产用 | 安全事故 | 文档明确"最小 token 校验骨架、非生产安全"；生产硬化划归后续/M11 安全轨 |
