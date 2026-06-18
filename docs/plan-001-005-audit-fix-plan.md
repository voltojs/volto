# Plan 001–005 实现审计与修复计划

> **状态**: Reviewed（2026-06-11 复核校正）
> **创建日期**: 2026-06-10
> **复核日期**: 2026-06-11
> **范围**: Plan 001（M1–M7）、Plan 002（M8）、Plan 003（M9）、Plan 004（M10）、Plan 005（M11）
> **关联**: [roadmap.md](./roadmap.md)、各 Plan 文档 `plans/001-*` ~ `plans/005-*`

---

## 1. 审计结论概要

对 Plan 001–005 全量代码审查后，确认核心架构（纯函数内核、Runner、端口契约、工具定义、SDK 门面）整体落地扎实。**复核要点（2026-06-11）**：

- `node scripts/check-core-zero-deps.mjs` **通过**，核心零依赖铁律未破。
- 全量 `test` **全部通过**（48/49 task 成功，唯一失败为 `store-file#build`；其 vitest 用例本身 10/10 通过——失败仅发生在 `tsc` 类型检查/构建阶段）。
- 全量 `typecheck` **仅 `store-file` 失败**（40/41 通过）。
- 全量 `lint` **6 个包共 19 处错误**（详见 §3），原始文档仅记录 3 处，**严重低估**。

> ⚠️ **原始文档校正**：(1) 阻塞 CI 的实际只有 **H1**（store-file 构建失败）与 **§3 全部 lint 错误**；**H2–H5（adapter 缺失）不阻塞 CI**——它们是可选注入，缺失时工具经能力门控自动不可见，构建/类型/测试全绿，应归类为"功能完整性缺口（可推迟）"而非 CI 阻塞。(2) lint 错误数从 3 修正为 19，新增 runtime-node / sdk / tools-data / tools-document 四个包。(3) M3 修复方法表述有误，已重写（根因是 ESLint 缺 `argsIgnorePattern`，参数本身已是 `_req`）。

| 层级 | 数量 | 特征 | 是否阻塞 CI |
|------|------|------|------|
| **HIGH（CI 阻塞）** | 1 | 构建/类型检查失败（H1） | ✅ 阻塞 |
| **HIGH（功能缺口，可推迟）** | 4 | 运行时 adapter 缺失（H2–H5） | ❌ 不阻塞（工具自动不可见） |
| **MEDIUM（CI 阻塞）** | 19 处 / 6 包 | lint 错误（M1–M7） | ✅ 阻塞 lint 门控 |
| **LOW** | 2 | 文件结构 / CLI 接线（L1–L2） | ❌ 不影响功能 |

---

## 2. HIGH 问题

> **分级说明（复核校正）**：仅 **H1 阻塞 CI**（`tsc` 失败）。H2–H5 是运行时 adapter 缺失，属可选注入；缺失时对应工具经 ToolRouter 能力门控自动从可见集摘除，`build / typecheck / lint / test` 仍全绿，**不阻塞 CI**，可按宿主需求推迟实现。

### H1 — `store-file` 构建失败（类型缺失） ✅ 已核实

**文件**: `packages/stores/file/src/__tests__/store.test.ts:26,87`、`tc-e4-atomic-write.test.ts:8`

**根因**: Plan 005 Phase 3（self-correct）在 `AgentState` 新增了 `selfCorrectionCount`（`packages/core/src/state.ts:163`）和 `maxSelfCorrections`（`:165`）字段，但 `store-file` 测试中 inline 构造的 state 对象未同步更新。`tsc` 报 `TS2739: ... is missing the following properties from type 'AgentState': selfCorrectionCount, maxSelfCorrections`。

**修复方案**: 在被类型检查的 2 处 inline state 对象（`store.test.ts:26`、`:87`）与 `tc-e4-atomic-write.test.ts:8` 的 `emptyState` 共 3 处补上 `selfCorrectionCount: 0` 和 `maxSelfCorrections: undefined`。

> 📌 **补充**：`store.test.ts:55` 还有第 4 处 inline state，但它被包在 `JSON.stringify(...)` 内，不参与对 `AgentState` 的类型检查，**不报错**——故仅前 3 处需要修复以恢复构建；为一致性建议第 4 处也一并补上（非必需）。

**验证**: `pnpm turbo run build typecheck --filter @volto/store-file` 通过。

---

### H2 — `browser` 运行时 adapter 缺失 ✅ 已核实

**文件**: `packages/runtimes/node/src/` 下缺少 `browser.ts`

**现状**: `@volto/tools-browser`（`packages/tools/browser/src/index.ts`）定义了 `BrowserAdapter` 接口 + 5 个工具（`browser_navigate / click / type / screenshot / get_page_text`），SDK `packages/sdk/src/create-agent.ts:200,357,409` 接受 `browserAdapter` 注入、声明 `browser:control` 能力并注册工具，但 **Node runtime 没有提供任何实现**。reference CLI 也无法提供。

**修复方案**: 在 `runtimes/node/src/browser.ts` 中实现 `createNodeBrowserAdapter()`，底层用 Playwright 或 Puppeteer。声明 `browser:control` 能力。Playwright 作为可选依赖（peerDependency）。

**优先级**: 可推迟至宿主需求明确后实现。当前 `browser_*` 工具通过能力门控自动不可见，不阻塞其他功能。

---

### H3 — `LSP` 运行时 adapter 缺失 ✅ 已核实

**文件**: `packages/runtimes/node/src/` 下缺少 `lsp.ts`

**现状**: `@volto/tools-code`（`lsp-client.ts` / `lsp-tools.ts`）定义了 `LspClient` 接口 + 5 个工具（`lsp_definition / references / rename / diagnostics / hover`），SDK `create-agent.ts:197,354,400` 接受 `lspClient` 注入并声明 `lsp:query` 能力。但 Node runtime 没有 LSP 客户端实现。

**修复方案**: 在 `runtimes/node/src/lsp.ts` 中实现 `createNodeLspClient()`，通过 stdio 启动 language server 进程并走 LSP 协议通信。依赖 `vscode-languageserver-protocol` 或类似库。

**优先级**: 可推迟。缺 adapter 时 LSP 工具自动不可见。

---

### H4 — `DatabaseAdapter` 运行时 adapter 缺失 ✅ 已核实

**文件**: `packages/runtimes/node/src/` 下缺少 `database.ts`

**现状**: `@volto/tools-data` 定义了 `DatabaseAdapter` 接口 + `db_query`/`db_exec` 工具，SDK `create-agent.ts:203,360,418` 接受 `dbAdapter` 注入、声明 `db:query`/`db:exec` 能力并注册工具。Plan 005 Phase 6 文档说实现 SQLite 参考实现，但实际只落了接口和 mock 测试（`packages/tools/data/src/__tests__/db-tools.test.ts`）。

**修复方案**: 在 `runtimes/node/src/database.ts` 中实现 `createSqliteDatabaseAdapter()`，底层用 `better-sqlite3` 或 `sql.js`。连接串经 `Secrets` 端口解析。

**优先级**: 可推迟。缺 adapter 时 db 工具自动不可见。

---

### H5 — `DocumentParserAdapter` 运行时 adapter 缺失 ✅ 已核实

**文件**: `packages/runtimes/node/src/` 下缺少 `document-parser.ts`

**现状**: `@volto/tools-document` 定义了 `DocumentParserAdapter` 接口 + `read_document` 工具，SDK `create-agent.ts:206,364,424` 接受 `documentParser` 注入、声明 `document:parse` 能力并注册工具。Plan 005 Phase 7 文档说实现 pdf-parse/mammoth/xlsx 等参考实现，但实际只落了接口和 mock 测试（`packages/tools/document/src/__tests__/read-document.test.ts`）。

**修复方案**: 在 `runtimes/node/src/document-parser.ts` 中实现 `createNodeDocumentParser()`，按 MIME 类型分发到对应解析库。各解析库作为可选 peerDependencies。

**优先级**: 可推迟。缺 adapter 时 `read_document` 自动不可见。

---

## 3. MEDIUM 问题 — lint 错误（CI 阻塞）

> **复核校正**：原始文档仅记录 3 处（M1–M3）。实测 `pnpm turbo run lint --continue --force` 共 **19 处错误 / 6 个包**，全部阻塞 lint 门控。下表为完整清单，原始文档遗漏 runtime-node（5）、sdk（6）、tools-data（4）、tools-document（1）。

| 包 | 数量 | 文件 | 规则 |
|----|------|------|------|
| core | 1 | `__tests__/permission-mode-replay.test.ts:4` | no-unused-vars |
| eval | 2 | `replay.ts:92`、`simulate.ts:101` | no-unused-vars |
| tools-document | 1 | `__tests__/read-document.test.ts:10` | no-unused-vars |
| tools-data | 4 | `__tests__/db-tools.test.ts:7,10` | no-unused-vars |
| runtime-node | 5 | `scheduler.ts:43` + 3 个 test 文件 | no-unused-vars |
| sdk | 6 | `__tests__/tc-plan004-verification.test.ts` | no-explicit-any |

### 🔑 根因与统一修复（优先）

多处 `_` 前缀参数（`simulate.ts` 的 `_req`、`db-tools.test.ts` 的 `_sql`/`_params`）**仍被报错**，因为根级 `.eslintrc.cjs` 未为 `@typescript-eslint/no-unused-vars` 配置 `argsIgnorePattern`。**建议先做一处配置修复**，可一次性消除所有 `_` 前缀误报：

```js
// .eslintrc.cjs — 在 rules 中追加（或在 extends 后覆盖）
"@typescript-eslint/no-unused-vars": ["error", {
  argsIgnorePattern: "^_",
  varsIgnorePattern: "^_",
  caughtErrorsIgnorePattern: "^_",
}],
```

> 注：该规则当前来自 `plugin:@typescript-eslint/recommended` 默认配置（无忽略前缀）。加上以上配置后，`_req` / `_sql` / `_params` 不再报错；其余**非 `_` 前缀**的真实死代码仍需逐一处理（见下）。

### M1 — `core`: 未使用的 import ✅ 已核实

`packages/core/src/__tests__/permission-mode-replay.test.ts:4` — `createDefaultPermissionConfig` import 后未使用。**修复**: 删除该 import。

### M2 — `eval`: 未使用的变量 ✅ 已核实

`packages/eval/src/replay.ts:92` — `totalPassed` 赋值后未使用。**修复**: 删除该行，或用于 summary（如 `All ${totalPassed} steps passed.`）。

### M3 — `eval`: 未使用的参数 ✅ 问题属实，原修复方法有误（已重写）

`packages/eval/src/simulate.ts:101` — `createScriptedModelPort` 的 `_req: ModelRequest` 参数（接口签名要求保留，但实现不用）被报错。

> ⚠️ 原始文档建议"将参数改为 `_req: ModelRequest`"——参数本身**已经**叫 `_req`，该建议无效。真实根因是 ESLint 缺 `argsIgnorePattern`（见上"根因与统一修复"）。**修复**: 加上 `argsIgnorePattern: "^_"` 配置即可，无需改动该文件。

### M4 — `tools-document`: 未使用的参数 🆕 原始文档遗漏

`packages/tools/document/src/__tests__/read-document.test.ts:10` — mock 实现中 `filePath` 参数未使用。**修复**: 改名为 `_filePath`（配合上面的 `argsIgnorePattern`），或在 mock 中实际使用。

### M5 — `tools-data`: 未使用的变量/参数（4 处） 🆕 原始文档遗漏

`packages/tools/data/src/__tests__/db-tools.test.ts:7,10` — mock `DatabaseAdapter` 的 `sql` / `_sql` / `_params`（×2）未使用。其中 `_sql`/`_params` 是 `_` 前缀误报（配置修复后消失）；`sql`（`:7`，无前缀）需改名为 `_sql`。

### M6 — `runtime-node`: 未使用的变量/import（5 处） 🆕 原始文档遗漏

| 位置 | 标识符 | 性质 |
|------|--------|------|
| `src/scheduler.ts:43` | `fireAt` | **生产代码** — `clock.now() + delayMs` 计算后从未使用（`ScheduledTask` 未记录触发时间）。删除该行，或将 `fireAt` 存入 task 结构。 |
| `__tests__/egress.test.ts:17` | `createRecordingNetwork` | 未使用的 import，删除。 |
| `__tests__/runner-policy-engine.test.ts:47` | `findToolResult` / `toolName` | 未使用的局部函数/参数，删除或加 `_` 前缀。 |
| `__tests__/sandbox.test.ts:3` | `SandboxPolicy` | 未使用的 type import，删除。 |

> 📌 `scheduler.ts` 的 `fireAt` 虽是小问题，但侧面反映 `createNodeScheduler` 目前是**桩实现**——定时触发后只标记 `fired`，并未把 wake-up input 回喂 agent 主循环（见 `scheduler.ts:50-52` 注释）。属已知功能缺口，可在调度能力真正接线时一并处理。

### M7 — `sdk`: `no-explicit-any`（6 处） 🆕 原始文档遗漏

`packages/sdk/src/__tests__/tc-plan004-verification.test.ts:177,275,308,311,346(×2)` — 测试中使用 `any`，违反 `@typescript-eslint/no-explicit-any`。**修复**: 替换为精确类型（如 `ModelEvent` / `AgentInput` 等），或对该测试文件局部放宽规则。

> 💡 **可选的全局策略**：上述大量 lint 错误集中在 `__tests__` 下。当前 `.eslintrc.cjs` 仅对 `packages/core/src/__tests__` 放宽了**纯度**规则，未对测试文件放宽 `no-explicit-any` / `no-unused-vars`。若团队认可，可考虑为 `**/__tests__/**` 增加一档 override 放宽 `no-explicit-any`，但 `no-unused-vars` 建议保留（死 import 应当清理）。此为权衡项，非强制。

---

## 4. LOW 问题

### L1 — `tools/document` 文件结构不符约定 ✅ 已核实（约定执行本身不一致）

**文件**: `packages/tools/document/src/index.ts`（106 行）

**问题**: Plan 005 Phase 7 文档约定创建 `read-document.ts` 存放工具实现，但 `DocumentParserAdapter` 接口 + `createReadDocumentTool` 全部写在 `index.ts`。功能正常，仅不符约定。

> 📌 **补充**：`@volto/tools-browser` 同样把 5 个工具全部塞在 `index.ts`（无拆分），而 `tools-code` 则拆成了 `lsp-client.ts` / `lsp-tools.ts`。即"按职责拆文件"这一约定在仓库内本就执行不一致。修 L1 时建议顺带统一 `tools-browser`，或干脆将该约定降级为非强制建议。

**修复**: 将 `createReadDocumentTool` 和 `DocumentParserAdapter` 接口拆到 `read-document.ts`，`index.ts` 只做 re-export。

---

### L2 — reference CLI 未接线 M8–M11 能力

**文件**: `apps/reference-cli/src/main.ts`

**问题**: CLI 只接了 fs/shell/network/modelPort/taskTool，未接线 MCP、LSP、browser、db、document、scheduler、cost meter、权限模式等能力。

**修复**: 逐步补充接线，优先 MCP（最高独立价值）。非阻塞。

---

## 5. 修复优先级与执行顺序

| 优先级 | 问题 | 预计工作量 | 前置依赖 |
|--------|------|-----------|---------|
| **P0** | H1 `store-file` 构建失败 | 5 分钟 | 无 |
| **P0** | ESLint 配置加 `argsIgnorePattern: "^_"`（统一消除 `_` 前缀误报） | 2 分钟 | 无 |
| **P0** | M1–M7 lint 错误（19 处 / 6 包，扣除上一步后剩余非 `_` 前缀死代码） | 20 分钟 | 上一步 |
| **P1** | H2–H5 adapter 实现 | 各 1–2 天 | 无（可并行） |
| **P2** | L1 文件拆分（含 tools-browser 一致性） | 15 分钟 | 无 |
| **P2** | L2 CLI 接线 | 持续 | H2–H5 完成后 |

**建议**：先做 ESLint 配置修复 → 清理剩余 lint 死代码 → 修 H1，三步即可恢复 CI 全绿；再按宿主需求优先级逐个实现 adapter。

> ⚠️ **修复实测注意**：`__tests__` 下未使用的 import（如 `createRecordingNetwork`、`SandboxPolicy`）多数是"曾用后删测试逻辑"留下的死引用，删除即可，**不会**影响测试覆盖。删除后务必重跑对应包的 `test` 确认无回归。

---

## 6. 验收标准

1. `pnpm turbo run build typecheck lint test` 全量通过（含 `store-file`）。
   - 当前实测：`test` 已全绿（仅 `store-file#build` 因 `tsc` 失败）；`typecheck` 仅 `store-file` 失败；`lint` 19 处 / 6 包失败 ⇒ 修完 H1 + M1–M7 后应全绿。
2. `node scripts/check-core-zero-deps.mjs` 通过 — **当前已通过**（核心零依赖未破）。
3. 各 adapter（H2–H5）实现后，对应工具在注入 adapter 的宿主中可被模型选用并正确执行。
4. 缺 adapter 时对应工具仍通过能力门控自动不可见（向后兼容）— **当前已满足**。

---

## 7. 复核结论（2026-06-11）

| 原条目 | 结论 |
|--------|------|
| H1 | ✅ 属实，修复方法正确（补 3 处类型字段）。 |
| H2–H5 | ✅ adapter 确实缺失，修复方向合理；但**严重级别校正**：不阻塞 CI，应归为"可推迟功能缺口"。 |
| M1、M2 | ✅ 属实，修复正确。 |
| M3 | ✅ 问题属实，但**原修复方法表述错误**（参数已是 `_req`），已重写为 ESLint 配置修复。 |
| L1、L2 | ✅ 属实；L1 补充了仓库内拆分约定执行不一致的事实。 |
| **新增 M4–M7** | 🆕 原文遗漏的 16 处 lint 错误（tools-document / tools-data / runtime-node / sdk）。 |

**总体**：原文档方向正确、核心问题（H1）抓得准，但 **lint 错误规模被严重低估（3 → 19）**、**H2–H5 的 CI 影响被高估**、**M3 修复方法有误**。以上均已在本文档校正。
