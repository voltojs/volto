# Plan 009 — Sandbox 执行隔离(补全 M11 Phase 2 + Shell 装饰器接线,macOS + Linux)

> **Status**: Draft
> **Owner**: TBD
> **Created**: 2026-06-12
> **Depends on**: Plan 002(M8 已在 `core/src/ports.ts` 立下 `Sandbox` 端口契约);Plan 005(M11 Phase 2 声称交付 Sandbox adapter,实为占位,本 Plan 补全);架构设计 [docs/pure-agent-core.md](../docs/pure-agent-core.md)
> **Target area**: `packages/runtimes/node/src/{sandbox,sandbox-proxy,shell}.ts`、`packages/sdk/src/{create-agent,defaults}.ts`、`apps/reference-cli/src/main.ts`、`packages/tools/shell/`(仅消费,不改签名)、`packages/core/`(**零改动**,仅复用既有 `Sandbox` 端口类型)
> **平台范围**: macOS(Seatbelt)+ Linux(bubblewrap + seccomp + egress proxy);Windows 不在范围

## 1. Background

### 1.1 Problem statement

内核要让模型自主跑 `bash` 等命令时具备**纵深防御**:即使发生 prompt injection 或模型误操作,被放行的命令也只能在 OS 内核级牢笼里执行——无法写工作区外的文件、无法窃取 SSH key / `.env`、无法外联未授权主机。这与权限系统(模型视角的"应不应该")是**正交的两层**,缺一不可。

参考业界两家成熟实现的共识(详见 §4.1):

- **Claude Code**:沙箱包裹 Bash 工具及其所有子进程;macOS 用 Seatbelt(`sandbox-exec`),Linux 用 bubblewrap + seccomp;违规在 syscall 层失败,无弹窗;网络经本地 proxy + 域名 allowlist。内部数据显示沙箱让权限弹窗减少 84%。
- **Codex CLI**:三档 mode(`read-only` / `workspace-write` / `danger-full-access`);sandbox policy 与 approval policy **独立评估**;macOS Seatbelt,Linux Landlock + seccomp helper 子进程;沙箱模式默认断网。

### 1.2 Current-state audit

Plan 005 Phase 2 的 checkbox 已勾选 `[x]`,但实际交付的 `packages/runtimes/node/src/sandbox.ts` 是**占位骨架**,且**从未接入任何工具**。审计如下:

| 维度 | 当前实现 | 目标状态 |
|---|---|---|
| Sandbox 端口契约 | `core/src/ports.ts` `Sandbox.run(spec)` 已定义 ✅ | 不动,继续复用(core 零改动) |
| bash 工具接线 | `create-agent.ts:461` `createBashTool(opts.shell)` 传**裸 Shell**,沙箱形同虚设 | SDK 在沙箱配置存在时,用 `createSandboxedShell(realShell, config)` 包裹后再注入 |
| macOS seatbelt profile | `buildSeatbeltProfile`(`sandbox.ts:49`):`(allow file-read-data (subpath "/"))` 全盘可读;写权限**未收窄到 cwd**;路径未转义 `"`,可注入 | 写权限收窄到 `writableRoots`;`readOnlyOverlays`(`.git`/`.env`)显式 `(deny file-write*)`;路径转义;网络默认 `(deny network*)` |
| Linux "landlock" 后端 | `sandbox.ts:124` 实际只跑 `unshare --net`——**仅隔离网络,文件系统零隔离**,名不副实 | 删除该占位,改用 **bubblewrap**(`bwrap`)做 mount/pid/user namespace 文件隔离;装饰器把命令重写为 `bwrap <binds> -- /bin/bash -c <cmd>`(与 macOS sandbox-exec 同构) |
| Linux syscall 过滤 | 无 | 可选 seccomp 过滤,阻断 unix domain socket 逃逸通道(放行 `AF_UNIX` IPC 必需者),`prctl(PR_SET_NO_NEW_PRIVS)` |
| egress 网络过滤 | `sandbox.ts:106` 靠读 `spec.env["EGRESS_HOST"]` 比对——无人设此 env,等于无过滤;seatbelt 分支 `(allow network* (remote-host))` 全放行 | 默认断网(macOS `(deny network*)` / Linux `--unshare-net`);开启时经**本地 proxy + 域名 allowlist**(`socat` 桥接 unix socket),跨平台精确 host 过滤 |
| denial 归一化 | 无(沙箱未接线,无从触发) | 命令被内核拒绝 → 转 `ToolResult { isError: true }` 回喂模型,**绝不抛异常**(铁律 §3.3) |
| `SandboxExecSpec.isolation` 字段 | `"none"|"process"|"container"` 与 adapter 的 `backend: seatbelt|landlock|none` 是两套悬空词汇 | 装饰器方案下 bash 走 Shell 接口,不直接用 `Sandbox.run`;`isolation` 字段保持现状,本 Plan 不依赖它 |

### 1.3 Design goals

1. **core 零改动** —— 沙箱纯属 imperative-shell,`step()` reducer / PermissionPolicy / ContextAssembler 不感知任何 OS 机制;仅复用 M8 已有的 `Sandbox` 端口类型,不新增端口。
2. **三层正交控制** —— 能力门控(可见?)→ 权限策略(应不应该?)→ **沙箱隔离(物理能不能?)**,三层独立、互不替代。
3. **Shell 装饰器接入** —— `createSandboxedShell(realShell, config)` 实现同样的 `Shell` 接口,把命令重写为 `sandbox-exec -p <profile> <原命令>` 后委托 realShell,复用既有流式机制;工具与核心零感知,可热插拔。
4. **越界不中断循环** —— 沙箱拒绝归一为 `isError` ToolResult 回喂,模型据此自纠或触发权限审批流(铁律 §3)。
5. **soft 回退可配硬门** —— 沙箱起不来默认 warning + 裸跑;`failIfUnavailable: true` 转硬错误。
6. **确定性可重放** —— 沙箱拒绝产出的 `isError` 内容是确定性的(不含时间戳/随机),重放纪律不破。

## 2. Goals

1. 修复 `buildSeatbeltProfile`,产出可用于生产的 macOS Seatbelt profile:写权限收窄到 `writableRoots`、`readOnlyOverlays` 强制只读、路径转义、网络默认拒绝。
2. 新增 `createSandboxedShell(realShell, config): Shell` 装饰器,把 bash 命令在 macOS 上经 `sandbox-exec` 包裹执行。
3. SDK `createAgent` 暴露 `sandboxConfig` 选项;存在时自动用装饰器包裹注入给 bash 工具的 Shell;不存在则行为与今日完全一致(向后兼容)。
4. 实现三档 mode(`read-only` / `workspace-write` / `danger-full-access`)的跨平台语义(macOS + Linux)。
5. Linux 后端:用 bubblewrap 做文件隔离(`writableRoots` 可写、其余只读、cwd 外写被内核拒绝)、默认 `--unshare-net` 断网;可选 seccomp 阻断 unix socket 逃逸。
6. 跨平台 egress 白名单:`network.allowedHosts` 经本地 proxy + `socat` 桥接做精确域名过滤,未授权主机被拒。
7. 沙箱拒绝(越界写 / 外联 / 资源越限)归一为 `ToolResult { isError: true }` 并带可操作的 `modelContent`,绝不抛异常。
8. `reference-cli` 增加 `AGENT_SANDBOX_MODE` 环境变量演示端到端效果。
9. 在 darwin 与 Linux 上分别手工验收:cwd 外写被拒、`.git`/`.env` 被拒、默认断网、egress allowlist 生效、错误回喂模型且主循环不中断。

## 3. Non-Goals

1. **不改 `packages/core/`** —— 不新增/修改任何端口类型或 reducer 逻辑。
2. **不改 bash 工具签名** —— `createBashTool(shell: Shell)` 保持不变,沙箱对工具透明。
3. **不做 Windows** —— 超出当前平台范围;非 macOS/Linux 平台回退 `none` + 显式告警(或 `failIfUnavailable` 硬门)。
4. **不替代权限系统** —— 沙箱是第三层纵深防御,PermissionPolicy(第二层)继续独立工作。
5. **不用 Landlock 直绑 syscall** —— Linux 文件隔离用 bubblewrap(CLI 包裹,适配装饰器),不直接调 Landlock LSM API(需 helper 二进制,破坏装饰器纯度);理由见 §4.6。
6. **不做 web/network 工具(web_fetch 等)的沙箱化** —— 本 Plan 的 egress proxy 治理 **shell 子进程**的出网;走 `Network` 端口的 web 工具其 egress 管控是独立面(可复用本 Plan 的 proxy/allowlist,但接线留作后续)。
7. **不做容器后端(Docker/OCI)** —— `SandboxExecSpec.isolation: "container"` 字段保持悬空,本 Plan 仅做进程级(seatbelt/bubblewrap)隔离。

## 4. Key decisions

### 4.1 三层正交控制模型(沙箱是第三层)

**决策**:沙箱作为与"能力门控""权限策略"正交的**第三层**控制,严格分层:

```
模型 tool_call → [第1层 能力门控 ToolRouter 纯函数: 工具可见?]
              → [第2层 权限策略 PermissionPolicy 纯函数: allow/deny/ask?]
              → [第3层 沙箱隔离 Sandbox shell 层: 放行命令在 OS 牢笼里跑] ★本 Plan★
              → Runner 解释 ExecuteToolEffect → SandboxedShell → sandbox-exec
```

**理由**:Claude Code 明确区分这两层——`deny Read` 规则只挡内建文件工具,挡不住 `cat .env`,后者必须靠 OS 级隔离。本项目 `AGENTS.md` 已有"门控 vs 权限"二分,沙箱是天然延伸。Codex 也将 sandbox policy 与 approval policy 独立评估。三层独立保证:即使第 2 层被绕过(prompt injection 诱导 allow),第 3 层内核仍兜底。

### 4.2 接入方式:Shell 装饰器(而非 bash 工具直连 Sandbox port)

**决策**:新增 `createSandboxedShell(realShell: Shell, config: SandboxConfig): Shell`,实现 `Shell` 接口。其 `exec(cmd, opts)` 按平台把 `cmd` 重写为隔离包裹命令后,再委托 `realShell.exec()`:
- **macOS**:`sandbox-exec -p <profile> /bin/bash -c <escaped cmd>`
- **Linux**:`bwrap <namespace/bind 参数> -- /bin/bash -c <escaped cmd>`
- **其余平台**:原样委托 + 告警(或 `failIfUnavailable` 硬门)

**理由**:
- `createNodeShell` 已用 `spawn(cmd, { shell: true })`,装饰器只需重写命令字符串即可复用全部流式 / 超时 / abort 机制,**零重复造轮子**。
- **macOS `sandbox-exec` 与 Linux `bwrap` 都是命令行包裹器**,天然契合"命令重写"装饰器,同一抽象覆盖两个平台,无需引入 helper 二进制或改变执行模型。
- bash 工具签名 `createBashTool(shell: Shell)` 不变,工具和 core 对沙箱**完全透明**,符合"能力即注入"与"core 零改动"。
- 对比方案(bash 工具直连 `Sandbox.run`):`Sandbox.run` 用 `command + args[]`,与 bash `shell:true` 的整串命令语义错配,且要改工具签名 + 能力声明,改动面更大。**否决**。

**注意**:现有 `createNodeSandbox`(`Sandbox` 端口 adapter)与本装饰器是两条路径。本 Plan 复用 `buildSeatbeltProfile` 的修复成果,但 bash 走装饰器;`createNodeSandbox` 保留供未来直接 spawn 子进程的场景(如 task 子 agent),不在本 Plan 接线。Profile 构造逻辑抽到共享函数避免重复。

### 4.3 SandboxConfig 数据模型置于 runtime-node(core 不持有)

**决策**:`SandboxConfig` 定义在 `packages/runtimes/node/src/sandbox.ts`,不进 core:

```ts
type SandboxMode = "read-only" | "workspace-write" | "danger-full-access";
type SandboxBackend = "seatbelt" | "bubblewrap" | "none";
interface SandboxConfig {
  mode: SandboxMode;
  writableRoots?: string[];     // workspace-write 下可写;默认 [cwd, os.tmpdir()]
  readOnlyOverlays?: string[];  // 即使在可写区也强制只读;默认 [".git", ".env"]
  network?: {
    enabled?: boolean;          // 默认 false(断网)
    allowedHosts?: string[];    // 非空时经 proxy 精确放行这些 host,其余拒绝
  };
  seccomp?: boolean;            // Linux 专用;默认 true(阻断 unix socket 逃逸)
  backend?: SandboxBackend;     // 缺省自动探测:darwin→seatbelt,linux→bubblewrap,其余→none
  failIfUnavailable?: boolean;  // 默认 false(soft 回退);true 则不支持平台抛构造期错误
}
```

> 注:`backend` 由 `detectBackend()` 自动探测(替换现有 `seatbelt|landlock|none` 三态中的 `landlock` 为 `bubblewrap`)。Linux 上还会探测 `bwrap` / `socat` 二进制是否存在,缺失则按 `failIfUnavailable` 决定告警回退或硬错误。

**理由**:沙箱策略是 OS 强制(第 3 层"物理能不能")的纯实现数据,与 core 的决策职责无关。第 2 层 PermissionPolicy 已在 core 处理"应不应该"。把 SandboxConfig 留在 runtime-node 保证 core 零改动(Goal 1)。三档 mode 的语义见 §4.4。

### 4.4 三档 mode 的跨平台语义

三档 mode 语义平台无关,由各 backend 翻译为对应机制:

| mode | macOS(Seatbelt profile) | Linux(bwrap 参数) |
|---|---|---|
| `read-only` | `(deny default)` + 全盘只读 + 仅 `/dev` 等必需写 | `--ro-bind / /` + `--unshare-net`,无 `--bind` 可写挂载 |
| `workspace-write` | `writableRoots` → `(allow file-write* (subpath …))`,其余只读;`readOnlyOverlays` 显式 `(deny file-write*)` | `--ro-bind / /` 打底 + `writableRoots` 逐条 `--bind`;`readOnlyOverlays` 逐条 `--ro-bind` 覆盖;网络见 §4.7 |
| `danger-full-access` | **完全跳过包裹**,装饰器直接委托 realShell | 同左,完全跳过 `bwrap` |

**理由**:与 Codex 三档对齐,语义直观且平台无关——`SandboxConfig` 不含平台细节,backend 各自翻译。`danger-full-access` 跳过包裹而非"宽 profile/全 bind",保证零行为差异与零性能开销。

### 4.5 denial 归一化:错误回喂不抛异常

**决策**:`sandbox-exec` 因策略拒绝时通常以非零 exit code + stderr 含 `Operation not permitted` 等关键字结束。装饰器透传 `ShellEvent`(stdout/stderr/exit)给上层 bash 工具,由 bash 工具既有路径把非零退出 + stderr 汇成 `ToolResult`;sandbox 拒绝场景额外在 stderr 注入一行可操作提示(`[sandbox] 写越界被拒: <path>。如确需写此路径,请调整 sandboxConfig.writableRoots 或切换 mode。`)。**装饰器与工具均不抛异常**。

**理由**:铁律 §3.3——工具错误一律归一 `isError` 回喂,模型据此自纠。这同时复刻 Claude Code"越界则回落权限审批流"的体验。denial 文本不含时间戳/随机,保持重放确定性(Goal 6)。

### 4.6 Linux 后端:bubblewrap 而非 Landlock 直绑

**决策**:Linux 文件隔离用 **bubblewrap(`bwrap`)**,装饰器把命令重写为 `bwrap --ro-bind / / --dev /dev --proc /proc <--bind 可写根…> <--ro-bind overlay…> [--unshare-net] -- /bin/bash -c <escaped cmd>`。可选 seccomp 经 `--seccomp <fd>` 传入预编译 BPF 过滤器阻断 unix socket。

**理由**:
- bubblewrap 是**命令行包裹器**(Flatpak 同源),与 macOS `sandbox-exec` 同构,直接套用 §4.2 的命令重写装饰器,无需 helper 二进制或改执行模型——这是选 bwrap 而非 Codex 路线(Landlock LSM syscall + helper 子进程)的决定性理由:Landlock 需在目标进程内调 `landlock_*` syscall,必须自带 helper 可执行文件,破坏"纯命令重写"的装饰器纯度。
- bwrap 无守护进程、`clone(2)` 直接建 namespace,开销极小,适合每次 bash 调用。
- 用 user namespace 免 root;mount namespace 把 `/usr`/`/lib` 等系统路径 `--ro-bind` 只读、cwd `--bind` 可写。

**风险与缓解**(详见 §6):Ubuntu 24.04+ 默认 AppArmor 策略会阻止非特权 user namespace → 启动期探测并按 `failIfUnavailable` 处理;嵌套容器内无法 mount 新 `/proc` → 提供 `--proc` 复用宿主(对齐 Claude Code `enableWeakerNestedSandbox`,后续按需加)。

### 4.7 egress 网络白名单:本地 proxy + socat 桥接(跨平台)

**决策**:`network.allowedHosts` 非空时,在沙箱外启动一个**本地 HTTP/SOCKS proxy**(校验请求 host 是否在 allowlist,否则返回 403),沙箱内经 unix domain socket + `socat` 桥接到该 proxy,并把 `HTTP(S)_PROXY` env 注入子进程。Linux 额外用 `--unshare-net` + seccomp 在 socket 层挡掉绕过 proxy 的非 loopback 流量;macOS 靠 Seatbelt network 规则做 backstop。

- `network.enabled = false`(默认):完全断网(macOS `(deny network*)` / Linux `--unshare-net`),不起 proxy。
- `network.enabled = true` 且 `allowedHosts` 为空:全放行(仅去掉断网)。
- `network.enabled = true` 且 `allowedHosts` 非空:起 proxy,仅放行清单内 host。

**理由**:这是 Claude Code / Codex 共同的网络治理模型——allowlist 校验在 proxy 层,socket 层兜底挡绕过。proxy 进程随沙箱生命周期管理,allowlist 静态校验确定性强。**本阶段只治理 shell 子进程出网**,web_fetch 工具的 egress 复用同一 allowlist 但接线留作后续(Non-Goal 6)。

**复杂度提示**:proxy + socat 是本 Plan 最重的工程,单列 Phase 4,可在 P0–P3(断网即默认安全)交付后独立推进;若 `socat` 缺失,按 `failIfUnavailable` 降级为"仅断网/全放行"二态并告警。

## 5. Implementation plan

> 递进顺序:Phase 0 定档契约 + backend 探测(零行为变更)→ Phase 1 macOS profile + 装饰器 + 接线(端到端打通,本 Plan 的骨架)→ Phase 2 三档 mode + overlays + soft/硬门 + 重放确定性(策略语义,平台无关优先)→ Phase 3 Linux bubblewrap 文件隔离 + 断网 + seccomp → Phase 4 跨平台 egress 白名单 proxy(最重工程,可独立推进)→ Phase 5 reference-cli 演示 + 文档。严格串行,逐 Phase review + 单独 commit。macOS(P1)与默认断网(P3)各自即可构成安全可用形态,P4 egress allowlist 为增强。

### Phase 0: 契约定档 + backend 探测(零行为变更)

**Goal**: 落定 `SandboxConfig` / `SandboxBackend` 类型与装饰器接口签名,重写 backend 探测(`landlock`→`bubblewrap`),确认现有占位实现的缺口与复用边界,不改任何运行时行为。

**Files covered**:
- `packages/runtimes/node/src/sandbox.ts`(新增 `SandboxConfig` / `SandboxMode` / `SandboxBackend` 类型 + 导出;改 `detectBackend`;标注占位缺口)
- `packages/runtimes/node/src/index.ts`(导出新类型)

**Tasks**:
- [x] 在 `sandbox.ts` 新增 `SandboxMode` / `SandboxBackend` / `SandboxConfig`(含 `network.{enabled,allowedHosts}`、`seccomp`、`backend`、`failIfUnavailable`)类型并从 `index.ts` 导出
- [x] `detectBackend()`:`darwin→seatbelt`、`linux→bubblewrap`、其余 `none`;新增 `probeBinary(name)` 探测 `sandbox-exec`/`bwrap`/`socat` 是否存在(实现可留后续 Phase,Phase 0 仅签名 + 桩)
- [x] 声明 `createSandboxedShell(realShell, config): Shell` 函数签名(空实现 / 直接委托 realShell,行为暂等同裸 shell)
- [x] 把 `buildSeatbeltProfile` 抽成接受 `SandboxConfig` 的纯函数签名(实现留 Phase 1);预留 `buildBwrapArgs(config)` 签名(实现留 Phase 3)
- [x] 删除/改写 `sandbox.ts:124` 误导性的 `unshare --net` "landlock" 分支,顶部注释标注 bubblewrap 实现见 Phase 3
- [x] `pnpm turbo run typecheck lint test --filter @agent-core/runtime-node` 通过

**Acceptance Criteria**:
1. `SandboxConfig` / `SandboxBackend` / `createSandboxedShell` 类型可从 `@agent-core/runtime-node` 导入,typecheck 通过。
2. `detectBackend()` 在 darwin 返回 `seatbelt`、linux 返回 `bubblewrap`。
3. 未配置沙箱时所有现有测试绿,无行为变更。

<!-- Backfill after execution:
**Reviewed**: 2026-06-12 by reviewer
**Commit**: <commit hash> <commit message subject>
-->

---

### Phase 1: macOS Seatbelt profile 修复 + 装饰器 + SDK 接线(端到端打通)

**Goal**: macOS 上 bash 命令真正经 `sandbox-exec` 隔离执行:cwd 外写被内核拒绝、默认断网、拒绝归一回喂不 crash。

**Files covered**:
- `packages/runtimes/node/src/sandbox.ts`(`buildSeatbeltProfile` 实现 + `createSandboxedShell` 实现)
- `packages/sdk/src/create-agent.ts`(新增 `sandboxConfig` 选项;沙箱存在时包裹 shell 再传 `createBashTool`)
- `packages/sdk/src/defaults.ts`(可选默认)

**Tasks**:
- [ ] 实现 `buildSeatbeltProfile(config)`:`(deny default)` + 全盘只读 `(allow file-read*)` + `writableRoots` 逐条 `(allow file-write* (subpath "<escaped>"))` + `network` 为 false 时 `(deny network*)`;路径做 `"` 转义
- [ ] 实现 `createSandboxedShell(realShell, config)`:macOS 且 mode≠`danger-full-access` 时重写 `cmd` 为 `sandbox-exec -p <profile> /bin/bash -c <escaped cmd>` 委托 realShell;否则原样委托
- [ ] 非 macOS 平台:`createSandboxedShell` 委托原样 + 一次性 `console.warn` 告警(除非 `failIfUnavailable` 见 Phase 2)
- [ ] `create-agent.ts`:新增 `sandboxConfig?: SandboxConfig` 选项;在 `createBashTool(opts.shell)` 处改为 `createBashTool(opts.sandboxConfig ? createSandboxedShell(opts.shell, opts.sandboxConfig) : opts.shell)`
- [ ] denial 归一:装饰器透传 ShellEvent;不抛异常(沙箱进程自身 spawn 失败也归一为 exit + stderr)
- [ ] `pnpm turbo run typecheck lint test --filter @agent-core/runtime-node --filter @agent-core/sdk` 通过

**Acceptance Criteria**:
1. 在 darwin 上,`sandboxConfig.mode = "workspace-write"` 时,bash 执行 `echo x > /tmp/outside_$$.txt`(cwd 外)被拒,exit 非零,stderr 含权限拒绝信息。
2. 同配置下 cwd 内写文件成功。
3. 默认 `network: false` 时 bash 执行 `curl https://example.com` 失败(被 profile 拒绝)。
4. `mode = "danger-full-access"` 时行为与未配置沙箱完全一致(命令裸跑)。
5. 沙箱拒绝时主循环不中断,错误作为 `ToolResult isError` 回喂(可在 reference-cli 或单测中观察)。
6. 未配置 `sandboxConfig` 时,SDK 行为与今日逐字节一致。

<!-- Backfill after execution:
**Reviewed**: <date> by reviewer
**Commit**: <commit hash> <commit message subject>
-->

---

### Phase 2: 三档 mode + readOnlyOverlays + soft/硬门 + 重放确定性

**Goal**: 补全三档 mode 完整语义、`.git`/`.env` 强制只读 overlay、`failIfUnavailable` 硬门,并以重放测试锁定沙箱拒绝的确定性。

**Files covered**:
- `packages/runtimes/node/src/sandbox.ts`(mode 分支 + overlays + failIfUnavailable)
- `packages/runtimes/node/src/__tests__/`(新增沙箱单测)

**Tasks**:
- [ ] `read-only` mode:profile 仅放行 `/dev` 等必需写,业务路径全只读
- [ ] `readOnlyOverlays`(默认 `[".git", ".env"]`):在 `writableRoots` 内对这些子路径追加 `(deny file-write* (subpath "<root>/.git"))`,顺序确保 deny 覆盖 allow
- [ ] `failIfUnavailable: true`:非 macOS 或 `sandbox-exec` 不存在时,`createSandboxedShell` 抛出构造期错误(在 SDK 装配阶段,非主循环内)
- [ ] 单测:三档 mode 各自的 profile 快照测试;overlay 拒绝 `.git` 写;路径转义注入用例(命令含 `"` 不破坏 profile)
- [ ] 重放测试:同一越界命令两次执行,归一的 `isError` `modelContent` 逐字节一致
- [ ] `pnpm turbo run typecheck lint test --filter @agent-core/runtime-node` 通过

**Acceptance Criteria**:
1. `read-only` mode 下任何业务写被拒,读成功。
2. `workspace-write` + 默认 overlays 下,`echo x > .git/config`(cwd 内但 overlay)被拒。
3. `failIfUnavailable: true` 在不支持平台抛构造期错误,且错误不发生在 agent 主循环内。
4. 重放测试证明沙箱拒绝输出确定性(无时间戳/随机)。
5. 含特殊字符(`"`、`$`)的命令不破坏 profile 也不逃逸沙箱。

<!-- Backfill after execution:
**Reviewed**: <date> by reviewer
**Commit**: <commit hash> <commit message subject>
-->

---

### Phase 3: Linux bubblewrap 文件隔离 + 断网 + seccomp

**Goal**: Linux 上 bash 命令经 `bwrap` 隔离执行:`writableRoots` 可写、其余只读、cwd 外写被内核拒绝、`readOnlyOverlays` 强制只读、默认 `--unshare-net` 断网;可选 seccomp 阻断 unix socket。

**Files covered**:
- `packages/runtimes/node/src/sandbox.ts`(`buildBwrapArgs(config)` 实现 + `createSandboxedShell` Linux 分支 + `bwrap`/`socat` 探测)
- `packages/runtimes/node/src/__tests__/`(Linux 沙箱单测,平台守卫跳过非 Linux)

**Tasks**:
- [ ] 实现 `buildBwrapArgs(config)`:`--ro-bind / /` 打底 + `--dev /dev` + `--proc /proc` + `writableRoots` 逐条 `--bind` + `readOnlyOverlays` 逐条 `--ro-bind`(覆盖顺序在 `--bind` 之后)+ `network.enabled=false` 时 `--unshare-net` + `--die-with-parent`
- [ ] `createSandboxedShell` Linux 分支:`bwrap <args> -- /bin/bash -c <escaped cmd>` 委托 realShell;复用 Phase 2 的三档 mode 翻译
- [ ] 可选 seccomp(`config.seccomp` 默认 true):预编译 BPF 阻断 `socket(AF_INET/AF_INET6)` 但放行 `AF_UNIX`,经 `--seccomp <fd>` 传入;无法生成时降级告警(不阻断启动)
- [ ] `bwrap` 缺失 / user namespace 被 AppArmor 阻止:启动期探测,按 `failIfUnavailable` 决定告警回退或硬错误
- [ ] 单测(Linux only,`process.platform !== "linux"` 时 skip):cwd 外写被拒、cwd 内写成功、`.git` overlay 被拒、`--unshare-net` 下 curl 失败、特殊字符命令不逃逸
- [ ] `pnpm turbo run typecheck lint test --filter @agent-core/runtime-node` 通过

**Acceptance Criteria**:
1. Linux 上 `workspace-write` 时 cwd 外写被拒、cwd 内写成功(与 Phase 1 的 macOS 行为对等)。
2. `read-only` 时业务写全拒;`readOnlyOverlays` 内 `.git` 写被拒。
3. 默认 `network.enabled=false` 时 `curl` 失败(网络 namespace 隔离)。
4. `bwrap` 不可用时按 `failIfUnavailable` 正确告警回退 / 硬错误,且不在主循环内抛异常。
5. 三档 mode 的 bwrap 参数构造有单测覆盖(快照),含特殊字符注入用例。

<!-- Backfill after execution:
**Reviewed**: <date> by reviewer
**Commit**: <commit hash> <commit message subject>
-->

---

### Phase 4: 跨平台 egress 网络白名单(本地 proxy + socat 桥接)

**Goal**: `network.allowedHosts` 非空时,sandbox 内出网经本地 proxy 按域名白名单放行,未授权 host 被拒;macOS 与 Linux 共用同一 proxy/allowlist 逻辑。

**Files covered**:
- `packages/runtimes/node/src/sandbox-proxy.ts`(新增:本地 HTTP/SOCKS proxy + allowlist 校验 + 生命周期管理)
- `packages/runtimes/node/src/sandbox.ts`(`createSandboxedShell` 接 proxy:注入 `HTTP(S)_PROXY` env + `socat` unix socket 桥接;Linux 调整 `--unshare-net`/bind socket;macOS profile 放行 loopback)
- `packages/runtimes/node/src/__tests__/`(egress allowlist 单测)

**Tasks**:
- [ ] `sandbox-proxy.ts`:启动本地 proxy(随沙箱命令生命周期 start/stop),对 CONNECT/请求校验 host ∈ `allowedHosts`,命中放行、否则 403/拒绝;监听 unix socket
- [ ] Linux:`bwrap` 内 `--bind` proxy 的 unix socket,`socat` 把 `TCP-LISTEN:<port>` 桥接到该 socket,注入 `HTTP_PROXY`/`HTTPS_PROXY`;保留 `--unshare-net` + seccomp 作 socket 层 backstop
- [ ] macOS:Seatbelt profile 放行 loopback / 到 proxy 的连接,其余 `(deny network*)` 作 backstop;注入 proxy env
- [ ] 三态语义落地:`enabled=false`→断网不起 proxy;`enabled=true`+空 `allowedHosts`→全放行;`enabled=true`+非空→proxy 白名单
- [ ] `socat` 缺失(Linux):按 `failIfUnavailable` 降级为"断网/全放行"二态 + 告警
- [ ] 单测:allowlist 命中放行、未命中拒绝;allowlist 校验为确定性纯逻辑(可重放)
- [ ] `pnpm turbo run typecheck lint test --filter @agent-core/runtime-node`(及受影响包)通过

**Acceptance Criteria**:
1. `network={enabled:true, allowedHosts:["example.com"]}` 时,bash `curl https://example.com` 成功、`curl https://evil.com` 被拒(403 或连接失败)。
2. `enabled=false` 时完全断网且不启动 proxy 进程(无端口泄漏)。
3. proxy 进程随沙箱命令结束被清理,无悬挂进程 / 端口。
4. allowlist 校验逻辑有单测,判定确定性。

<!-- Backfill after execution:
**Reviewed**: <date> by reviewer
**Commit**: <commit hash> <commit message subject>
-->

---

### Phase 5: reference-cli 演示 + 文档

**Goal**: 参考宿主演示端到端沙箱(macOS + Linux);更新架构文档说明三层模型与跨平台后端矩阵。

**Files covered**:
- `apps/reference-cli/src/main.ts`(`AGENT_SANDBOX_MODE` + `AGENT_SANDBOX_ALLOW_HOSTS` 环境变量 → `sandboxConfig`)
- `docs/pure-agent-core.md`(三层控制模型 + 沙箱 ports + 平台后端矩阵)
- `plans/005-m11-safety-isolation-reliability.md`(标注 Phase 2 占位实现已由 Plan 009 补全)

**Tasks**:
- [ ] `main.ts`:读 `AGENT_SANDBOX_MODE`(三档,缺省不启用沙箱)+ `AGENT_SANDBOX_ALLOW_HOSTS`(逗号分隔 → `network.allowedHosts`)构造 `sandboxConfig` 传入 `createAgent`
- [ ] `docs/pure-agent-core.md` 增"三层正交控制(门控/权限/沙箱)"小节 + 平台后端矩阵(macOS seatbelt / Linux bubblewrap+seccomp+proxy / 其余 none)
- [ ] 在 Plan 005 §Phase 2 处追加备注:占位实现缺口与本 Plan 的补全关系
- [ ] 手工验收(darwin + 一台 Linux):`AGENT_SANDBOX_MODE=workspace-write` 跑 CLI,令模型尝试写 cwd 外文件 / curl 未授权 host,观察被拒且对话继续
- [ ] `pnpm turbo run typecheck lint test`(全量)通过

**Acceptance Criteria**:
1. macOS 与 Linux 上 `AGENT_SANDBOX_MODE=workspace-write ./reference-cli`,模型越界操作被拒并收到 isError 回喂,对话不崩。
2. 配 `AGENT_SANDBOX_ALLOW_HOSTS` 时仅清单内 host 可达。
3. 不设 `AGENT_SANDBOX_MODE` 时 CLI 行为与今日一致。
4. `docs/pure-agent-core.md` 含三层模型说明 + 平台矩阵;Plan 005 已标注补全关系。

<!-- Backfill after execution:
**Reviewed**: <date> by reviewer
**Commit**: <commit hash> <commit message subject>
-->

## 6. Risks and mitigations

| Risk | Impact | Mitigation |
|---|---|---|
| Seatbelt profile 语法写错导致命令全部失败或全部放行 | 高 | Phase 2 profile 快照测试 + 手工验收三档 mode;profile 出错时 sandbox-exec 自身报错,归一为 isError 而非静默放行 |
| 路径含 `"`/`$` 注入破坏 profile | 高(可逃逸沙箱) | Phase 1 强制转义 + Phase 2 注入用例;profile 路径只接受绝对路径并 resolve |
| `sandbox-exec` 在新版 macOS 被弃用警告 | 中 | Apple 仍保留该命令;deprecation 仅 warning 不影响功能;文档标注,长期可迁移到 Endpoint Security |
| denial 检测靠 stderr 关键字,误判 | 中 | 首阶段不做精细分类,统一作为非零退出归一 isError;提示文本通用化,不声称精确原因 |
| `danger-full-access` 被误设为默认 | 高 | SDK 默认不启用沙箱(向后兼容)且 mode 无默认值,必须显式指定;reference-cli 缺省也不启用 |
| 与现有 `createNodeSandbox` 两条路径产生维护分叉 | 低 | profile/bwrap 参数构造抽共享纯函数;注释标注两条路径用途 |
| Ubuntu 24.04+ AppArmor 默认禁非特权 user namespace,`bwrap` 起不来 | 高(Linux) | Phase 3 启动期探测 user namespace 可用性;失败按 `failIfUnavailable` 告警回退/硬错误;文档给出 AppArmor profile 配置指引 |
| `bwrap` / `socat` 未安装 | 中(Linux) | 启动期 `probeBinary` 探测;缺失则降级 + 告警或硬门;文档注明 `apt install bubblewrap socat` |
| 嵌套容器内无法 mount 新 `/proc` | 中(Linux) | 提供复用宿主 `/proc` 的弱化选项(对齐 Claude Code `enableWeakerNestedSandbox`),默认关闭,文档警示其暴露面 |
| egress proxy 被绕过(直连非 loopback) | 高 | Linux `--unshare-net` + seccomp socket 层兜底;macOS Seatbelt `(deny network*)` 兜底;proxy 仅作便利层,内核隔离才是边界 |
| 路径技巧绕过(如 `/proc/self/root/...`) | 中 | bwrap mount namespace 从源头限制可见文件系统;denylist 不作为唯一防线;Phase 加红队用例 |
| proxy 进程泄漏 / 端口占用 | 中 | proxy 绑定沙箱命令生命周期,exit/abort 时强制 stop;单测验证无悬挂 |
