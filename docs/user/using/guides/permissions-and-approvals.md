---
title: Permissions and approvals
type: guide
source:
  - apps/gateway/src/permission-modes.ts
  - apps/gateway/src/config/permissions.ts
  - packages/core/src/permission-presets.ts
  - apps/web/components/chat/ApprovalCard.tsx
generated: false
verified: 2026-11-11
---

# Permissions and approvals

> After reading: know what each of the four permission modes blocks, when an approval card appears, and how to use rules to reduce interruptions without widening the boundary.

## The four permission modes

Every conversation has a permission mode; new sessions take their default from "Settings → General → Default permission for new sessions".

| Mode | Sandbox | Approval | Best for |
| --- | --- | --- | --- |
| Read-only | Read-only | Reads allowed, every write denied | You only want the agent to read code and propose a plan |
| Ask | Writable workspace | Small in-workspace edits (such as `edit_file`) are allowed directly; high-risk actions such as writing whole files or executing commands ask you first | Default, most common |
| Auto | Writable workspace | Everything inside the workspace allowed; **irreversible operations are still denied outright**, never asked | You trust the current task and want fewer interruptions |
| Full | No isolation | No restrictions, no more prompts | Only when you fully trust the task; a confirmation dialog appears before enabling it |

"Auto" does not mean everything is allowed: irreversible operations that cross the current sandbox boundary (for example `git_push`) are denied outright rather than prompting — because what that mode promises is "no interruptions".

**Plan mode** is not a fifth mode: it is the "read-only + produce a plan first" way of working, entered with `/plan` and left after you approve the plan.

"Settings → General → Default permission for new sessions" only decides which mode **sessions created afterwards** start in; a running session keeps the mode it started with, and you can also adjust it individually in the session's own permission selector.

## The three choices on an approval card

- Allow once
- Deny (the agent receives the denial and changes approach; it does not get stuck)
- Always allow… (only appears for qualifying `bash` commands)

"Always allow" writes the command prefix into the rules, takes effect **from the next turn**, and is user-level (applies to all projects). If the write fails (read-only directory, full disk), this time still runs as "Allow once", and the card explains the failure reason.

## Reducing interruptions with rules

Rule shape (the `permissions` section of `~/.volto/config.json`):

```json
{
  "rules": [
    { "pathPattern": "**/.env", "decision": "ask" },
    { "toolName": "write_file", "pathPattern": "src/**", "decision": "allow" },
    { "toolName": "bash", "commandPrefix": ["pnpm", "test"], "decision": "allow" }
  ]
}
```

Rules match in order and **the first match wins**; the three decisions are `allow` / `deny` / `ask`.

## The real shape of the boundaries

These three points matter more than any example:

1. **Rules can only tighten, never widen.** However many `allow` rules you add in read-only mode, writes are still not allowed.
2. **Path rules only constrain tools that declare a path argument.** `bash` declares no path argument, so `pathPattern` cannot govern the shell — the shell's boundary is the sandbox itself.
3. **Hostname rules are not a firewall.** `hostPattern` only filters approval for tools that declare a URL argument; what actually blocks the network is the `egress` section, and it applies to three network tools only — it does not stop `curl` running inside bash.

The same honest statement, said twice: what this system blocks is "the model slipping", not "the model being induced". For the full threat model see [Safety model](../../concepts/safety-model.md).

## The bar for command prefix rules

`commandPrefix` only applies to a **single simple command**. When the command contains `;` `&` `|` `<` `>` backticks `$` `(` `)` wildcards, a leading environment-variable assignment (`FOO=1 cmd`) or unclosed quotes, it is asked as usual.

It matches the argv token prefix: `pnpm test --filter x` matches, `pnpm test2` does not.

**It is not a security boundary**: equivalent alternative spellings (`bash -c 'pnpm test'`) are still asked; an alias left behind in the bash session can also make a textually identical command do something else.

## When changes take effect

The `permissions` section is re-read on the next session construction. To see the effect of a rule change immediately, start a new session.

A broken configuration (JSON syntax error, misspelled field name) **refuses to start** instead of silently dropping the rules — this is intentional: silent failure is far more dangerous than an error.

For the full set of fields see [Configuration file reference](../reference/config.md).
