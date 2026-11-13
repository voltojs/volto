---
title: Configure a model and start your first conversation
type: tutorial
source:
  - apps/web/components/settings*
  - apps/web/messages/zh/settings.json
  - apps/gateway/src/config/providers.ts
generated: false
verified: 2026-11-11
---

# Configure a model and start your first conversation

> After reading: configure a model provider, choose a workspace, and have the agent change code once.

## Prerequisites

The gateway and the Web UI are already running (see [Install and start](./01-install.md)).

## Steps

### 1. Open Settings → Models

Open "Settings" and pick the "Models" tab. Providers and the models under them are managed here.

### 2. Add a provider

Two entry points; pick one according to the provider type:

- **Add a built-in provider**: pick from the built-in provider catalog (Anthropic, OpenAI and a batch of compatible vendors); you only fill in the API key, and the model list can be completed from the catalog automatically.
- **Add a custom provider**: fill in an OpenAI-compatible endpoint (base URL) and a model ID yourself; suited to self-hosted gateways or private deployments.

Click save when done. **The API key is stored encrypted on the server** (the `providers` section of `~/.volto/config.json`) and never enters browser storage.

You should see: the provider card appears in the list, and expanding it shows the models under it.

### 3. Select the model to use

Enable at least one model in the provider card; go back to the chat page and select it in the model selector.

### 4. Choose a workspace

Click the workspace selector at the top and pick a local directory (or add one). The agent's file reads and writes and its command execution all use it as the working directory — it is not a limit on "what is accessible", see [Permissions and approvals](../guides/permissions-and-approvals.md).

### 5. Send your first message

Write a concrete task in the input box, for example:

```text
通读这个仓库的 README，用三句话说明它是做什么的，然后把结论写进 NOTES.md。
```

Press Enter. You will see model output, tool calls (reading files, writing files), and approval cards that need your go-ahead.

## You should see

- `NOTES.md` appears in the workspace.
- The right-hand pane shows the files and diffs involved in this change. The collapse button is at the far right of the pane's top bar; after collapsing, click "Expand pane" at the top of the chat to reopen it.
- The context usage is visible (it shows how much context this turn consumed).

## Next steps

[Understanding changes and approvals](./03-review-changes.md)
