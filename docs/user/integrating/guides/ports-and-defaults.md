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
| `approvalGate` | 需要审批的动作自动被拒或自动放行（取决于权限档） | 宿主弹窗的实现 |

### 有默认值、可以后补的

| 端口 | 默认行为 |
| --- | --- |
| `clock` / `id` / `random` | 真实时间、自增 + 时间戳的 id、`Math.random` |
| `tokenizer` | 按字符数估算（够用，不精确） |
| `sessionStore` | 内存，进程结束即丢 |
| `chatStore` / `transcriptStore` | 不持久化 |
| `eventSink` | 丢弃所有事件 |
| `memoryStore` / `embedder` | 空实现，`memory` 工具不可见 |
| `telemetry` / `auditSink` | 空实现 |
| `sandbox` | 无隔离（等价「完全」档） |
| `secrets` | 调用即抛错（明确告诉你不支持） |
| `scheduler` | 定时任务工具不可见 |
| `policyEngine` | 不做策略判定 |

## 沙箱与文件系统要一起看

`fs` 是你自己的实现，所以**沙箱不是自动的**。正确做法是让宿主的 `FileSystem` 实现跑在沙箱装饰里（仓库里 `packages/runtimes/node` 的 `sandboxed-filesystem.ts` 就是这么做的），而不是指望内核帮你隔离。

同理，`shell` 的隔离也由实现负责。**「有沙箱」是运行时事实，不是配置声明**——如果你的实现忽略了 `sandboxConfig`，那这个会话就是没有沙箱。

## 事件流是宿主的界面契约

`eventSink` 收到的每一条事件都是给界面用的：文本增量、工具开始/结束、审批请求、上下文用量、回合结束。官方的 Web UI 就是这些事件的消费者。

自己的 UI 建议直接照抄这套事件，而不是去读最终状态——最终状态只告诉你结果，不告诉你过程。

## 出问题怎么办

- **工具莫名消失**：先查是不是对应端口没传（可见性与能力是绑定的）。
- **测试不稳定**：检查是否用了真实时间/随机——注入固定 `clock` / `random` 即可重放。
- **两条会话互相污染**：`createAgent` 是单轮串行的，并发请每会话一个实例。