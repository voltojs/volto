---
title: Skills and MCP
type: guide
source:
  - apps/gateway/src/skills/registry.ts
  - apps/gateway/src/skills/frontmatter.ts
  - packages/tools/src/mcp
generated: false
verified: 2026-11-11
---

# Skills and MCP

> After reading: write a skill that makes the agent work by your rules; and know where MCP works today and where it does not.

## What a skill is

A skill is a set of instructions loaded on demand. It does not stay in the context — the agent first sees one line of "name + when to use it" and reads the body in only when it decides it needs to. That gives it specialized knowledge without burning context for nothing.

## Where they live

| Directory | Scope | Priority |
| --- | --- | --- |
| `~/.volto/skills/<skill name>/SKILL.md` | User-level, available to all projects | Low |
| `<workspace>/.volto/skills/<skill name>/SKILL.md` | Project-level, available only in that workspace | High (same name overrides user-level) |

One directory per skill, and the entry file must be called `SKILL.md`; other files in the same directory (templates, scripts) can be referenced from the body with `@path` and are expanded when the skill is loaded.

## How to write SKILL.md

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

- `name` matches the directory name.
- `description` decides when the agent thinks of it — write "when to use it", not just "what it is".
- The body is operating instructions for the model, not an introduction for people.
- `user-invocable: false` keeps it out of the `/` menu; `disable-model-invocation: true` makes it callable only by you manually. When neither switch is set, both sides can call it by default.

## When it gets used

- **You invoke it**: type `/skill-name` in the input box, or pick it from the `/` menu.
- **The agent decides itself**: it sees the skill catalog (names and descriptions only) and, when it thinks the current task matches, calls the `skill` tool to read the full text.

So "it never got used" is usually not a breakage, but a `description` that does not read like "when to use it".

## MCP: the current state

The MCP (Model Context Protocol) client is implemented (`@voltojs/tools/mcp`: stdio transport, tool discovery, resources and prompts), but **the official gateway and Web UI do not connect to it yet** — you will not find an entry point for adding an MCP server in the UI, and `config.json` has no corresponding section.

To use MCP today, mount `McpToolSource` into `createAgent({ toolSources })` in a self-built host; see [Custom host](../../integrating/guides/custom-host.md). This is host wiring work, not a configuration option.

## When something goes wrong

- **A skill does not appear in the `/` menu** → check `user-invocable: false`, and whether the directory name matches `name`.
- **The agent never uses it by itself** → rewrite `description` as a concrete trigger scenario ("use when the user asks for …").
- **`@file` in the body is not expanded** → the path is relative to the directory holding `SKILL.md` and must stay inside the same skill directory.
