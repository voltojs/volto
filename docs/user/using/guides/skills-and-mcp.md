---
title: 技能与 MCP
type: guide
source:
  - apps/headless-server/src/skills/registry.ts
  - apps/headless-server/src/skills/frontmatter.ts
  - packages/tools/mcp/src
generated: false
verified: 2026-11-11
---

# 技能与 MCP

> 读完你会：会写一个技能让 agent 按你的规矩干活；知道 MCP 现在能用在哪、不能用在哪。

## 技能是什么

技能是一段按需加载的说明。它不常驻上下文——agent 先看到一行「名字 + 什么时候用」，觉得需要时才把正文读进来。这样既有专业知识，又不白烧上下文。

## 放在哪

| 目录 | 作用范围 | 优先级 |
| --- | --- | --- |
| `~/.volto/skills/<技能名>/SKILL.md` | 用户级，所有项目可用 | 低 |
| `<工作区>/.volto/skills/<技能名>/SKILL.md` | 项目级，只在该工作区可用 | 高（同名覆盖用户级） |

一个技能一个目录，入口文件必须叫 `SKILL.md`；同目录下的其它文件（模板、脚本）可以通过 `@路径` 在正文里引用，加载时一并展开。

## SKILL.md 怎么写

```markdown
---
name: release-notes
description: 按本仓库的体例写发布说明。当用户要求整理 changelog、发布公告或版本说明时使用。
---

# 发布说明

1. 先读 `git log --oneline <上一个 tag>..HEAD`。
2. 按 新增 / 修复 / 破坏性变更 三类分组，只写用户能感知的变化。
3. 模板见 @template.md。
```

- `name` 与目录名一致。
- `description` 决定 agent 什么时候想起它——写「什么时候用」，不要只写「这是什么」。
- 正文是给模型看的操作说明，不是给人看的介绍。
- `user-invocable: false` 让它不出现在 `/` 菜单；`disable-model-invocation: true` 让它只能被你手动调用。两个开关都不写时默认可被双方调用。

## 什么时候会被用到

- **你主动调用**：在输入框敲 `/技能名`，从 `/` 菜单里选。
- **agent 自己判断**：它看到技能目录（只有名字与描述），觉得当前任务匹配就调用 `skill` 工具读取全文。

所以「它没被用上」通常不是坏了，而是 `description` 写得不像「什么时候用」。

## MCP：现在的状态

MCP（Model Context Protocol）客户端已经实现（`@volto/tools-mcp`：stdio 传输、工具发现、资源与提示词），但**官方网关与 Web 界面还没有接入它**——你在界面上找不到添加 MCP 服务器的入口，`config.json` 里也没有对应分区。

要现在用 MCP，需要在自建宿主里把 `McpToolSource` 挂进 `createAgent({ toolSources })`，详见 [自建宿主](../../integrating/guides/custom-host.md)。这是宿主接线的工作，不是配置项。

## 出问题怎么办

- **技能不出现在 `/` 菜单** → 检查 `user-invocable: false`，以及目录名与 `name` 是否一致。
- **agent 从不主动用它** → 把 `description` 改成具体的触发场景（「当用户要求 … 时使用」）。
- **正文里的 `@文件` 没展开** → 路径相对 `SKILL.md` 所在目录，且必须在同一技能目录内。