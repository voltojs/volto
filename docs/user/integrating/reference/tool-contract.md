---
title: Tool contract
type: reference
source:
  - packages/core/src/tool.ts
  - packages/sdk/src/tool-scope-default.ts
  - packages/tools/common/src
generated: false
verified: 2026-11-11
---

# Tool contract

> After reading this you will: be able to write a tool the kernel routes correctly, and know when it gets hidden.

## Declaring a tool

```ts
const definition = {
  name: "read_file",
  description: "读文件，带行号。",           // the model decides whether to use it from this sentence
  inputSchema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
  requires: ["filesystem:read"],             // capability: without it the tool is not visible to the model
  riskTier: "READ_ONLY",                    // the permission policy tiers by this
  pathInputs: ["path"],                     // path inputs: let pathPattern rules match
  hostInputs: [],                           // URL inputs: let hostPattern rules match
  commandInputs: [],                        // command inputs: let commandPrefix rules match
} as const;
```

Four fields decide whether it is seen and whether it is let through:

| Field | Effect |
| --- | --- |
| `requires` | **Visibility**: capability missing → never enters the model's visible set |
| `riskTier` | **Letting it through**: `READ_ONLY` / `WRITE_LOW` / `WRITE_HIGH` / `IRREVERSIBLE` |
| `pathInputs` / `hostInputs` / `commandInputs` | **Rule matching**: declare nothing and the matching rule can never hit |
| `trust` | Whether the output is marked as untrusted content (injection defense) |

"Visibility" and "letting it through" are two different things; do not mix them up:

- Visibility is decided by the wiring (is the matching port there, are the capabilities sufficient, is the tool budget sufficient).
- Letting it through is decided by permission (`allow` / `deny` / `ask`).
- A tool can be visible first and denied later; it does not drop out of the visible set just because it "might be denied".

## The two-layer result structure

```ts
function finish(diff: string, ms: number) {
  return {
    modelContent: "……",              // for the model: terse; when oversized it must be truncated with the truncation declared in the text
    displayMetadata: { diff, ms },    // for the UI: full content, duration, line counts
    isError: true,                    // a failure is a result too, not an exception
  };
}
```

- `modelContent` enters the context and costs money; truncating plus a "truncated" note beats filling it up.
- `displayMetadata` only travels through the event stream and never enters the context, so it can hold large objects.

## Tool budget

At any moment the model sees at most **20** tools by default (21 when memory is wired). Anything beyond that competes by tier priority, and tools that match no tier fall to the end.

This means **tools you add compete with the built-in ones for slots**. Many small tools are worse than one combined tool with parameters.

## Tool-writing checklist

- [ ] `name` is snake_case and globally unique
- [ ] `description` states "when to use it", not just "what it does"
- [ ] every field in `inputSchema` has a description — the model fills it in from that
- [ ] `requires` is declared, so the tool can be hidden correctly when the capability is missing
- [ ] `pathInputs` / `hostInputs` / `commandInputs` are declared (when applicable), otherwise permission rules have no effect on it
- [ ] failures return `isError: true`, never `throw`
- [ ] large output is truncated and the truncation is declared

## When something goes wrong

- **A tool does not appear**: check whether anyone grants the capability in `requires`, and whether the tool budget is exceeded.
- **Rules do not match**: most likely the matching input field is not declared.
- **The model calls the same tool over and over**: the `description` does not say when to stop, or the return value gives no "already done" signal.