---
title: Embed the agent in your own host
type: tutorial
source:
  - packages/sdk/src/create-agent.ts
  - packages/sdk/src/defaults.ts
  - packages/providers/pi-ai/src/model-port.ts
generated: false
verified: 2026-11-13
---

# Embed the agent in your own host

> After reading this you will: run one conversation in thirty lines of code, then swap in a real model.

## Prerequisites

- **Node ≥ 22** (confirm with `node -v`).
- Install the SDK:

  ```bash
  npm i @voltojs/sdk
  ```

- **Only an ESM entry point is provided** (no `require` in `package.json`). If your host uses `import`, just write it; if the host is CommonJS, load it as a module with a dynamic `import()`:

  ```js
  // CommonJS host (.cjs / old packages whose "type" is not "module")
  const { createAgent } = await import("@voltojs/sdk");
  ```

  Since Node 20.19 / 22.12, `require()` can load ESM too, but the SDK's actual support baseline is Node 22; do not rely on earlier behavior.

- Optional packages are installed separately as needed and are not all bundled in `@voltojs/sdk`: `@voltojs/provider-pi-ai`, `@voltojs/provider-openai`, `@voltojs/provider-anthropic`, `@voltojs/store-sqlite` and so on. Step one below uses only the defaults shipped with `@voltojs/sdk`, so you can skip installing them for now.

## Step one: verify the wiring with a fake model

`createAgent` has exactly one required option: the model connection (`modelPort`). Start with a scripted model — no network, no key:

```ts
import { createAgent } from "@voltojs/sdk";
import type { ModelPort } from "@voltojs/sdk";

// Scripted model: no network and no environment variables. Use it first to confirm the wiring is right.
const scripted: ModelPort = {
  async *stream() {
    yield { type: "text_delta", text: "你好，" };
    yield { type: "text_delta", text: "我在。" };
    yield { type: "done", stopReason: "end_turn" };
  },
};

const agent = createAgent({ modelPort: scripted });

for await (const event of agent.stream("介绍一下你自己")) {
  if (event.type === "text_delta") process.stdout.write(String(event.data.text ?? ""));
}
```

You should see: `你好，我在。`

This one call already walks the full real path — the core state machine, the tool router, the event stream — with only the model swapped for a fake. Wiring mistakes surface here, not in a paid request.

## Step two: switch to a real model

Use the pi-ai adapter to connect an OpenAI-compatible endpoint (a custom provider). Switching to any other vendor only means changing the configuration under `providers`. Install this adapter first:

```bash
npm i @voltojs/provider-pi-ai
```

```ts
import { createAgent } from "@voltojs/sdk";
import { createPiAiModelPort } from "@voltojs/provider-pi-ai";

const modelPort = createPiAiModelPort({
  providers: [
    {
      kind: "custom",
      id: "my-gateway",
      baseURL: "https://api.example.com/v1",
      apiKey: process.env.OPENAI_API_KEY,
      models: [{ code: "gpt-4.1-mini", contextWindow: 128_000 }],
    },
  ],
  defaultProviderId: "my-gateway",
  defaultModel: "gpt-4.1-mini",
});

const agent = createAgent({ modelPort });
const state = await agent.run("用一句话说明你刚做了什么");
console.log(state.status); // "done"
```

`run()` runs to the end of the turn and returns the final state; switch to `stream()` to render while it runs. One instance **serves only one turn at a time**; for concurrent sessions, call `createAgent()` per session.

## What to wire next

The defaults get both snippets above running, but a real host will eventually wire these:

| Goal | Option | See also |
| --- | --- | --- |
| Really read and write files | `fs` (otherwise file tools drop out of the visible set) | [Ports and default implementations](../guides/ports-and-defaults.md) |
| Really run commands | `shell` | Same as above |
| Let the user click "allow" | `approvalGate` | Same as above |
| Emit the events the UI needs | `eventSink` | Same as above |
| Session persistence / recovery | `sessionStore` + `chatStore` | Same as above |
| Limit which tools are available | `capabilities` / `tools` / `toolSources` | [Tool contract](../reference/tool-contract.md) |

## When something goes wrong

- **The model calls no tools at all**: most likely `fs` / `shell` was not passed — a tool with no matching port never appears in the visible set, so the model does not even know it exists.
- **Every tool call errors out**: tool execution errors are fed back to the model as a result with `isError: true` (they do not throw and break the loop); see what the model says next turn, or turn on `eventSink` and inspect the raw events.

For the full option list see [SDK guide](../reference/sdk-api.md).