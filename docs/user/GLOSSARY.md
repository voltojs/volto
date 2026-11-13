---
title: Glossary
type: reference
source:
  - docs/user/WRITING.md
generated: false
verified: 2026-11-13
---

# Glossary

Terms used across the user documentation. Keep these translations stable so the English
pages and the Chinese mirror (`zh/`) describe the same concept.

| English | 中文 | Notes |
| --- | --- | --- |
| agent | agent | The product itself; do not translate. |
| workspace | 工作区 | The directory an agent is allowed to work in. |
| session | 会话 | A conversation plus its persisted state. |
| turn | 回合 | One user message and everything that follows until the agent stops. |
| tool | 工具 | A capability the model can call (`read_file`, `bash`, …). |
| provider | 供应商 | A model vendor or an OpenAI-compatible endpoint. |
| model | 模型 | A concrete model id served by a provider. |
| approval | 审批 | A permission decision that waits for the user. |
| permission mode | 权限档位 | `ask`, `read-only`, `workspace-write`, `danger-full-access`. |
| sandbox | 沙箱 | The OS-level isolation around tool processes. |
| host | 宿主 | The process embedding the agent (gateway, desktop app, custom). |
| port | 端口 | An interface the core depends on; the implementation is injected. |
| capability | 能力 | A tool's declared permission category (not a model feature). |
| skill | 技能 | A reusable instruction bundle the agent can load. |
| memory | 记忆 | Project-scoped long-term notes the agent can write and retrieve. |
| subagent | 子代理 | A child agent dispatched by the main one. |
| transcript | 转录 | The persisted event log of a session. |
| checkpoint | 检查点 | A restore point inside a session. |
| gateway | 网关 | The HTTP + SSE host that serves the API and the Web UI. |
| slash command | 斜杠命令 | An input shortcut such as `/plan` or `/compact`. |
| reference | 参考 | A lookup page, not a tutorial. |

Configuration keys, commands, file paths, tool names and permission-mode names are never
translated.