---
title: 持久化与恢复
type: guide
source:
  - packages/core/src/ports.ts
  - packages/stores/jsonl/src
  - packages/sdk/src/transcript-reader.ts
  - apps/headless-server/src/sessions.ts
generated: false
verified: 2026-11-11
---

# 持久化与恢复

> 读完你会：知道该存哪三样东西，以及「重启后接着聊」到底靠什么恢复。

## 三样东西，别混

| 要存的 | 端口 | 内容 | 丢了会怎样 |
| --- | --- | --- | --- |
| 状态快照 | `SessionStore` | `{ id, state, createdAt }`，即内核的完整状态 | 会话无法原地续接 |
| 事件日志 | `TranscriptStore` + `TranscriptReader` | 追加式事件流（每轮发生了什么） | 界面历史、审计、导出全没了 |
| 会话元信息 | 宿主自己存 | 标题、工作区、模型、权限档 | 列表里认不出这段对话 |

官方宿主的做法：状态与会话元信息进会话库，事件进转录（JSONL，逐条追加），两者用同一个 `sessionId` 关联。转录通过 `createAgent({ chatStore })` 注入——它同时实现写（`TranscriptStore`）与读（`TranscriptReader`）。

## SessionStore 的契约

```text
interface SessionStore {
  save(snapshot: SessionSnapshot): Promise<void>;
  load(id: string): Promise<SessionSnapshot | undefined>;
  list(): Promise<SessionSnapshot[]>;
}
```

- `save` 是**覆盖式**：同一个 id 保存最新快照即可，不需要自己维护版本。
- `snapshot.state` 必须可序列化。里面有 Promise 的东西都不该进状态（内核已经把后台任务放在状态之外，正是这个原因）。
- 官方还有 file / sqlite / postgres 等实现，共用一套合同测试——自己写时建议照抄那套测试。

## 转录的契约

```text
interface TranscriptStore {
  appendEvents(sessionId: string, events: TranscriptEventInput[]): Promise<void>;
}
interface TranscriptReader {
  readEvents(sessionId: string): Promise<TranscriptEvent[]>;
}
```

- 只追加，不改写：这样审计轨迹可信，也让「重放」成为可能。
- 写入是**尽力而为**的：一次写入失败不应该让这一轮对话崩掉。官方实现里所有写入都包了兜底。

## 恢复的两种方式

1. **从快照恢复**：`load(id)` 拿到状态，用 `createAgent` 的种子选项（`initialMessages` / `initialTurn` / `initialStep`）重建实例。快、完整，但快照结构随内核版本演进，跨版本可能读不了。
2. **回放事件**：读转录、重新喂给内核。慢但更稳，也是重放测试的做法。

跨版本兼容策略要自己定：官方宿主选择「读不了就明确报错」（返回 410），而不是猜。

## 压缩与删除

- 压缩会改变状态，但**不删除历史事件**：转录保留全文，状态只保留摘要。所以「压缩后还能看旧消息」靠的是转录，不是状态。
- 删除会话要先删转录再删快照；顺序反了会留下孤儿事件。官方实现把删除收口在一个接口里，避免调用方自己排序。

## 审计与导出

- `AuditSink` 是另一条独立通道：工具调用、审批决定等写成审计流水（`~/.volto/audit.jsonl`）。它**不是**转录的替代品——一个是给人查的账本，一个是恢复对话的依据。
- 导出（Markdown / JSONL）从转录生成，不从状态生成：状态的形状是实现细节，转录才是可读的事实。

## 出问题怎么办

- **重启后会话打开是空的** → 只存了转录没存快照（或反之）；两者都要。
- **恢复后模型忘了刚才的工具结果** → 快照只存了状态而工具结果被裁剪过；用回放路径验证。
- **事件写失败导致整轮失败** → 检查你的 `appendEvents` 是否在内部吞掉了错误；它不应该把异常抛给调用方。
- **跨版本读不了旧会话** → 明确报错并提示导出；不要静默重置。