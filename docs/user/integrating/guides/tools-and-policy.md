---
title: Tool wiring and permission policy
type: guide
source:
  - packages/core/src/tool-router.ts
  - packages/core/src/permission-policy.ts
  - packages/sdk/src/tool-scope-default.ts
  - packages/core/src/permission-presets.ts
generated: false
verified: 2026-11-11
---

# Tool wiring and permission policy

> After reading this you will: be able to explain that "why a tool did not appear" and "why a call was denied" are two separate mechanisms, and tune each of them correctly.

## The stages a call goes through

The order is fixed: the first four stages decide "can it happen", the last three decide "what happened":

```text
register → capability gating → visibility trimming → permission decision → approval → execute → result normalization
```

| Stage | Decision | Carrier |
| --- | --- | --- |
| Capability gating | Does this host implement the capability it needs | `ToolDefinition.requires` × `capabilities` |
| Visibility trimming | How many tools the model may see at once | `ToolScopeConfig` + `limit` |
| Permission decision | allow / deny / ask for this call | `PermissionConfig` (`{ sandbox, approval }` + `rules`) |
| Approval | Who to ask when asking is needed | `ApprovalGate.ask(call, riskTier)` |

When the first two stages fail, the symptom is "the model does not even know this tool exists"; when the last two fail, the symptom is "the model knows it was denied". Mixing them up sends debugging in the wrong direction — see [Visibility and permission are two separate things](../../concepts/tools-and-permissions.md).

## Visibility trimming

By default the SDK derives it from the wiring; the groups and priorities are: file/command/git (100) · session basics (50) · memory (45) · mode groups lsp / db / browser (40) · informational (20) · everything else (0). The total cap is 20, or 21 when memory is wired.

To override it yourself, the shape is:

```ts
const scope = {
  groups: {
    fs: { priority: 100 },
    shell: { priority: 100 },
    browser: { priority: 40, enabled: false },
  },
  toolGroups: { mcp__srv__echo: "mcp" },
};
```

- Only tools in an **enabled group** are kept; tools not assigned to a group are excluded when `groups` is specified explicitly.
- The group name defaults to the first segment before `__` (`mcp__srv__echo` → `mcp`); a tool whose name has no `__` uses its **full name** as the group (`lsp_definition` → `lsp_definition`). The SDK's default wiring uses explicit `toolGroups` to place these names into the five tiers.
- Above the cap, tools compete by priority, and **equal priorities keep their original order** (stable trimming that does not jitter from turn to turn).

To make a group of tools disappear, use `enabled: false`; to make it invisible to the model altogether, removing the capability it `requires` is more thorough.

## Permission decisions

`PermissionConfig` is a pair plus rules:

```ts
const permission = { sandbox: "workspace-write", approval: "ask" };
```

- **Rules take precedence over the pair**: `rules` are matched in order and the first hit wins.
- `sandbox` is the capability boundary (read-only / writable workspace / no isolation); `approval` is the interruption policy (`never` / `ask`).
- Rules can only **tighten**: under a read-only boundary, any number of `allow` rules will not let a write through.

The inputs that rules match on are declared by the tool itself: `pathInputs` (paths, resolved to an absolute real path first), `hostInputs` (URL host names), `commandInputs` (command text). **A tool that declares nothing can never match the corresponding rule** — this is the most common trap.

## Approval

When `ask` is needed, the host implements:

```text
interface ApprovalGate {
  ask(call: PendingToolCall, riskTier: RiskTier): Promise<"allow" | "deny" | ApprovalResult>;
}
```

- The return value can be a bare `"allow"` / `"deny"`, or carry a reason (`ApprovalResult`); the reason goes into the `approval_decision` transcript event and the UI, but not into the fields of the audit trail.
- On timeout or host error, **deny** (fail-closed) rather than allow.
- An approval denial takes the same path as a permission denial: both become an `isError: true` tool result fed back to the model, and the model tries something else.

## Narrowing a subagent's permission

The `permission` preset passed when dispatching a subagent can only equal or be narrower than the parent session. A wider mode is rejected, and you get the list of allowed modes back. Internally this compares the rank of the sandbox boundaries, not string equality.

## Result normalization

A tool that throws, times out, or hits a port error is all normalized into `{ isError: true, modelContent: "…" }` and returned to the model, **never interrupting the main loop**. The host does not need a try/catch per tool: one wrapper would also wrap concurrent model calls and end up swallowing real loop failures.

## When something goes wrong

- **A tool is missing** → check whether the capability in `requires` is granted, whether the group is disabled, and whether it was squeezed out by the 20-tool cap.
- **A rule does not take effect** → check whether the tool declares the matching input; `bash` declares no path inputs, so `pathPattern` does nothing for it.
- **The model keeps hitting the same wall** → check whether the denial reason is readable; "not allowed to write `.env`" is far more useful than an empty error.