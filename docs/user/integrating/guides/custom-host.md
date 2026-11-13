---
title: Building your own host
type: guide
source:
  - packages/sdk/src/create-agent.ts
  - apps/gateway/src/wiring.ts
  - packages/tools/mcp/src
generated: false
verified: 2026-11-11
---

# Building your own host

> After reading this you will: know what the official gateway does for you, and how many lines a minimal working host really needs.

## What the official gateway does

`apps/gateway` is not part of the kernel; it is only a **wiring example**: it connects the SDK to the Node-side implementations and exposes them to the frontend over HTTP + SSE. You can replace the whole thing.

What it does for you, in order of importance:

| Task | Matching SDK option / port | What happens without it |
| --- | --- | --- |
| Connect to a model | `modelPort` | It will not run |
| Read and write files | `fs` (with the sandbox decorator) | File tools disappear |
| Run commands | `shell` (persistent session + sandbox) | Command tools disappear |
| Ask the user | `approvalGate` | Calls that need approval fail outright |
| Send progress to the UI | `eventSink` | The UI can only wait for the final result |
| Store sessions | `sessionStore` + transcript | A restart means amnesia |
| Permission mode | `permissionConfig` | The default mode is used (writable + ask every time) |
| Workspace reminder | `resolveWorkspaceReminder` | The model does not know which branch it is on |
| Instruction layers | `resolveContextLayers` | Project conventions such as AGENTS.md never reach the context |
| Skills | `skillRegistry` | Skills are unavailable |
| Subagent definitions | `agentSpecs` | Only the built-in types exist |
| Language server | `lsp` | The five `lsp_*` tools disappear |
| sqlite | `db` | `db_query` disappears (`db_exec` needs `allowWrite`) |
| Browser | `browserAdapter` | Browser tools disappear |

**"Disappear" is a clean degradation**: for a port that is not wired, the matching tool is removed from the set of tools the model can see, so the model never tries to call a tool that does not exist.

## A minimal working host

Order matters — get one turn working first, then add things:

1. `modelPort` (one adapter is enough).
2. Run one turn with `run()` and confirm that text comes out.
3. Add `eventSink` and print `text_delta` / `turn_end` to the terminal.
4. Add `approvalGate` and ask yes/no on the command line.
5. Add `fs` + `shell` so the tools actually work.
6. Add `sessionStore` + a transcript so the conversation continues after a restart.

Each step can be verified on its own, so when something breaks the search space is only the item you just added.

## Connecting MCP

The official gateway does not wire MCP yet; a custom host can wire it directly:

```ts
import { McpToolSource, StdioTransport } from "@voltojs/tools-mcp";

const mcp = new McpToolSource({
  servers: [
    {
      serverId: "fs",
      transport: new StdioTransport({
        command: "npx",
        args: ["-y", "@modelcontextprotocol/server-filesystem", "/tmp"],
      }),
    },
  ],
});

// Hand it to createAgent (modelPort is your model connection):
// const agent = createAgent({ modelPort, toolSources: [mcp] });
```

Tool names get a prefix (`mcp__<serverId>__<tool>`) and the capability string is `mcp:<serverId>` — so permission rules can be written at server granularity.

## What not to rebuild

- **The loop, context assembly, compaction, tool routing and permission decisions**: all live in the pure core; a rewrite only gets you a worse version.
- **Error normalization**: the kernel already guarantees that tool / model errors do not break the loop, so the host does not need to wrap another try/catch around it.
- **Replayability**: with the ports injected correctly, the same input sequence produces the same result twice; this is the foundation for testing and debugging.

## Checklist

- [ ] Every interface validates its input (the host is the trust boundary)
- [ ] The approval gate denies on timeout / error instead of allowing
- [ ] No heavy synchronous work in `eventSink` (it runs on the loop path)
- [ ] Session data can be deleted (the user can ask to forget a conversation)
- [ ] The sandbox state is visible (`full` / `partial` / `none`) instead of pretending there is isolation
- [ ] Secrets never reach logs, the model context or error messages