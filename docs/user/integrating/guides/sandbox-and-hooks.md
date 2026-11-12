---
title: 沙箱与钩子
type: guide
source:
  - packages/runtimes/node/src/sandbox.ts
  - packages/runtimes/node/src/sandbox-enforcement.ts
  - packages/core/src/hooks.ts
  - apps/gateway/src/config/hooks.ts
generated: false
verified: 2026-11-11
---

# 沙箱与钩子

> 读完你会：能判断自己的宿主到底有没有在隔离，以及能写一个真的会生效的钩子。

## 隔离发生在装配里，不在核心里

内核不调用任何沙箱。它只产出「执行这条命令 / 写这个文件」的效果，由你在装配时注入的 `shell` 与 `fs` 去执行。所以：

- **`SandboxConfig` 只是配置**，`{ mode, writableRoots, ... }` 描述你希望的边界。
- **真正做隔离的是实现**：把 `Shell` / `FileSystem` 包进沙箱装饰（runtime-node 的 `createSandboxedShell` / `createSandboxedFileSystem` 就是干这个的），官方网关在装配时调用它们。
- **内核里的 `Sandbox` 端口**（`run(spec)`，带命令、环境、`isolation: none | process | container`）留给「用独立执行器跑命令」的宿主；它默认的实现**一调用就抛错**，绝不会静默裸跑。官方网关不用它。

## 判断「到底有没有隔离」

看 `SandboxEnforcement`，不看配置：

| 值 | 含义 |
| --- | --- |
| `full` | 后端真实生效，越界操作会被系统拒绝 |
| `partial` | 部分约束生效（例如 Linux 上个别语义与 macOS 有差异） |
| `none` | 没有隔离，命令在裸环境里跑 |

runtime-node 里有一个专门的判定模块：先区分「runner 自己挂了」和「命令被拒绝」，再按后端方言匹配拒绝签名（seatbelt → `Operation not permitted`，bwrap → `Read-only file system`）。

**不要用「输出为空」或「非零退出码」判断隔离**——前者无法区分「没跑」和「什么也没输出」，后者无法区分「被拒」和「命令本身失败」。这两条踩过坑：曾有整整三轮 review 里沙箱其实没生效，而测试全绿。

## 钩子

生命周期共十个。**只有三个能否决，一个能改结果**，其余只做观察与记录：

| 生命周期 | 返回值的作用 | 什么时候 |
| --- | --- | --- |
| `preToolUse` | **能否决**（变成一条 `isError` 工具结果）或改入参 | 权限通过之后、执行之前 |
| `postToolUse` | **可修改**工具结果，再交给内核 | 工具执行完之后 |
| `userPromptSubmit` | **能否决**：拒绝这条 prompt，不开启回合 | 收到用户输入、调用模型之前 |
| `preCompact` | **能否决**：跳过这一次压缩 | 已决定压缩、还没生成摘要 |
| `session:start` / `session:end` | 忽略（只观察） | 会话建立 / 结束 |
| `turn:start` / `turn:end` | 忽略（只观察） | 一轮开始 / 结束 |
| `subagentStop` | 忽略（只观察，**反劫持**） | 子代理结果回到父会话 |
| `notification` | 忽略（只观察） | 预算告警、审批请求等系统事件 |

`subagentStop` 与 `notification` 的结果被忽略是刻意的：子代理的输出不能反过来指挥父会话，系统通知也不该成为控制通道。

### 命令钩子的契约

钩子命令从 stdin 收到一段 JSON 上下文，按退出码表达决定：

| 退出码 | 含义 |
| --- | --- |
| `0` | 继续。stdout 被丢弃——它永远不会进入模型上下文 |
| `2` | 拒绝，stderr 的**第一行**作为拒绝理由回给模型 |
| 其它非零、启动失败、超时 | **fail-closed 拒绝** |

单条钩子默认 10 秒超时，超时先 SIGTERM 再拒绝。stderr 有采集上限（约 64 KB），超出后仍继续读取但不累积——防止一个刷屏的钩子把宿主内存撑爆。

`preToolUse` 的否决与权限拒绝走同一条归一化路径：变成 `isError` 的工具结果，模型会换做法、不会卡住。

## 出问题怎么办

- **以为有沙箱其实没有** → 读 `SandboxEnforcement`，别读配置。`none` 时必须让用户知道。
- **钩子写了不生效** → 检查生命周期名拼写（必须是上表里的那一个），以及退出码是否真的返回 2。
- **钩子把整轮卡住** → 检查是否有交互式读取 stdin 的代码；钩子必须自己读完 stdin 并退出。
- **拒绝理由模型看不到** → 只观察的生命周期返回值被忽略；要影响流程得用可拒绝的生命周期。