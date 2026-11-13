---
title: 端口与默认实现
type: guide
source:
  - packages/sdk/src/defaults.ts
  - packages/core/src/ports.ts
generated: false
verified: 2026-11-11
---

# 端口与默认实现

> 读完你会：知道哪些端口必须自己实现、哪些留默认就行，以及不传会发生什么。

## 一个原则

内核不碰 I/O。时间、随机、ID、文件、命令、网络、存储全部是**注入进来的端口**。这条约束的收益是：同一串输入两次运行产生完全一致的 `(state, effects)`，可以录下来重放、可以快照测试、可以换宿主。

代价是：**你没传的端口，能力就真的不存在**——不是「报错」，而是对应工具从模型可见集里消失。

## 分组

### 必须正视的（决定 agent 能不能干活）

| 端口 | 不传时 | 建议实现 |
| --- | --- | --- |
| `modelPort` | **必填**，没它无法构造 | 用 `createPiAiModelPort` / `createOpenAIModelPort` / `createAnthropicModelPort`，或自己实现 `stream(ModelRequest)` |
| `fs` | 文件类工具（读写、搜索、glob）不可见 | 注意与沙箱装饰一起用，见下 |
| `shell` | `bash` 等命令工具不可见 | 持久会话能力靠它，别做成每条命令一个新进程 |
| `network` | 联网工具不可见 | 出口策略由你在实现里决定 |
| `approvalGate` | 默认门恒返回 `allow`：需要审批的动作**不会真的问你**，直接放行 | 宿主弹窗的实现 |

### 有默认值、可以后补的

| 端口 | 默认行为 |
| --- | --- |
| `clock` / `id` / `random` | 真实时间、自增 + 时间戳的 id、`Math.random` |
| `tokenizer` | 按字符数估算（够用，不精确） |
| `sessionStore` | 内存，进程结束即丢 |
| `chatStore`（转录实现） | 不持久化：对话记录不落盘 |
| `eventSink` | 丢弃所有事件 |
| `memoryStore` / `embedder` | 记忆库是内存实现；`embedder` 调用即抛错 |
| `telemetry` / `auditSink` | 空实现 |
| `sandbox` | 调用即抛错：明确要求你注入真实实现（不会静默裸跑）。注意隔离实际由 `fs` / `shell` 实现负责，见下 |
| `secrets` | 所有查询返回 `undefined`（当作没有该密钥） |
| `scheduler` | 空实现：`sleep` 立即返回、`schedule` 发出即忘 |
| `policyEngine` | 一律返回 `allow`（等于没有策略） |

## 沙箱与文件系统要一起看

`fs` 与 `shell` 都是你自己的实现，所以**沙箱不是自动的**。内核从不调用沙箱：它产出「执行命令」效果，由你注入的实现去做。正确做法是把它们包在沙箱装饰里——runtime-node 的 `createSandboxedShell` / `createSandboxedFileSystem` 就是这么做的，官方网关在装配时调用它们。

`SandboxConfig` 只是配置。**「有沙箱」是运行时事实**：如果你的实现忽略了它，这个会话就是没有沙箱，而此时 `sandbox` 端口仍可能挂着默认实现——它一调用就抛错，绝不会静默裸跑。

## 事件流是宿主的界面契约

`eventSink` 收到的每一条事件都是给界面用的：文本增量、工具调用与结果、审批请求与决定、上下文提醒、回合结束（token 用量挂在 `assistant_message` 上）。官方的 Web UI 就是这些事件的消费者。

自己的 UI 建议直接照抄这套事件，而不是去读最终状态——最终状态只告诉你结果，不告诉你过程。

## 出问题怎么办

- **工具莫名消失**：先查是不是对应端口没传（可见性与能力是绑定的）。
- **测试不稳定**：检查是否用了真实时间/随机——注入固定 `clock` / `random` 即可重放。
- **两条会话互相污染**：`createAgent` 是单轮串行的，并发请每会话一个实例。