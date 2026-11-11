---
title: 沙箱与平台支持
type: guide
source:
  - packages/runtimes/node/src/sandbox.ts
  - packages/runtimes/node/src/sandbox-enforcement.ts
  - apps/headless-server/src/wiring.ts
generated: false
verified: 2026-11-11
---

# 沙箱与平台支持

> 读完你会：知道自己这台机器上沙箱到底有没有生效，以及哪些平台干脆不能用隔离模式。

## 平台矩阵

| 平台 | 沙箱后端 | 只读 / 询问 / 自动 | 完全 |
| --- | --- | --- | --- |
| macOS | seatbelt（系统自带 `sandbox-exec`） | 完整隔离 | 无隔离，可用 |
| Linux | bubblewrap（需自行安装 `bwrap`） | 隔离可用，个别语义与 macOS 不同 | 无隔离，可用 |
| Windows / 其它 | 无 | **拒绝启动并报错** | 需要显式绕过后端检查（见下），网关自身没有入口 |

**后端缺失时显式拒绝启动，绝不静默裸跑。** 宁可你看到一条报错，也不要你以为有沙箱而实际上没有。

Linux 上装 bubblewrap：

```bash
# Debian / Ubuntu
sudo apt install bubblewrap
```

## 「有没有沙箱」是运行时事实

界面上的档位是**你要求的**，实际生效的是**跑起来的那个后端**。判断方式只有一个：看会话的沙箱状态（不是看配置里写了什么）。

这个区别不是洁癖：曾经有过「配置写着隔离、实际命令裸跑」的 bug，之后这条就成了纪律。

## 沙箱挡什么

- **只读档**：写文件、改目录、执行会写盘的命令都会被拒绝（拒绝发生在系统调用层，不是靠命令文本猜）。
- **询问 / 自动档**：工作区内可写；空间之外仍受隔离约束。
- **凭据目录**：`~/.volto`（配置、密钥、会话）在拒绝读取的名单里，agent 的普通文件工具读不进去。

## 已知不覆盖项（比承诺更重要）

- **读边界不是工作区围栏。** 沙箱允许读全盘（`~/.volto` 除外），所以读类工具在原理上能把工作区外文件的内容带回上下文。
- **完全档不隔离。** 它就是没有沙箱，只剩审批（而完全档的审批是「不询问」）。
- **`bash` 里起的进程不经过网络名单。** `egress` 只作用于三个网络工具。
- **语言服务器子进程受同样的沙箱约束、且默认封网**，但只读档下它可能写不了自己的缓存，超大仓会变慢。
- **网络过滤的 TCP 桥接依赖 `socat`**，缺失时会有警告，而不是静默降级。

## 出问题怎么办

- **启动就报 `[sandbox] No sandbox backend available on this platform`** → Linux 上装 `bwrap` 后重启。Windows 上目前没有可用后端：网关启动时用的是只读档，后端缺失即拒绝启动，界面上没有切换档位的机会。错误信息里的两条出路（改用 `danger-full-access`、或设 `failIfUnavailable: false`）是给**自建宿主**用的，不是界面开关。
- **命令莫名报 `Operation not permitted` / `Read-only file system`** → 这正是沙箱在工作。要写这个路径，换档位或换目录，而不是关沙箱。
- **只读档下语言服务器很慢** → 它在尝试写缓存被拒，属预期代价。

## 相关

- [权限与审批](./permissions-and-approvals.md)：审批与规则怎么配
- [安全模型](../../concepts/safety-model.md)：完整威胁模型与不承诺项