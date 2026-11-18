---
title: Configuring web search
type: guide
source:
  - packages/tools/src/web/web-search.ts
  - packages/tools/src/web/search
  - apps/gateway/src/config/web-search.ts
  - apps/web/components/settings/WebSearchCard.tsx
verified: 2026-11-18
generated: false
---

# Configuring web search

> After reading: point the agent's `web_search` tool at a search service you control, test it from the settings page, and know what happens when nothing is configured.

The `web_search` tool does not ship with a hardcoded search provider. It calls whatever source you configure in **Settings → Tools → Web Search**, and if nothing is configured it answers the model with setup guidance instead of a broken request.

## Picking a source

- **Auto (default)** — follows the session's model channel. If that channel is DeepSeek and has an API key, the tool reuses that key and talks to `https://api.deepseek.com/v1/tools/search`; nothing else to configure. Any other channel means "not configured" until you pick a source.
- **DeepSeek** — same endpoint, authenticated either with a key you enter here or with a DeepSeek model channel's key. With several channels, choose which one under **Authentication → Reuse a model channel**.
- **Brave** — `https://api.search.brave.com/res/v1/web/search`, needs a Brave Search subscription token.
- **GLM** — `https://open.bigmodel.cn/api/paas/v4/web_search` (`search_std` engine), needs a Zhipu key.
- **Custom** — any REST search service: method, URL, auth header and prefix, extra headers, a request body template, and the JSON paths of the result list and its fields.
- **Off** — removes `web_search` from the model's tool set entirely.

Each source keeps its own encrypted key. Switching sources never sends one service's key to another.

## Custom sources

A custom source is one request. For POST, the body template substitutes two placeholders:

- `{{query}}` — the JSON-escaped query; write the surrounding quotes yourself, e.g. `{"q": "{{query}}", "n": {{count}}}`.
- `{{count}}` — the requested number of results.

For GET, both placeholders live in the URL and are URL-encoded. The mapping fields are dotted paths into the response, e.g. `search_result` for the list, then `title` / `link` / `content` for the fields. Saving validates what can be checked without a response — the method, the URL, the required mapping paths and that the body template renders valid JSON. Whether the paths match the real response is proved by **Test search** or the first call, so test a new source before relying on it.

## Testing

**Test search** runs one query with exactly the resolution a new session would get, through the same egress-wrapped network port, so a passing test means the agent will pass too. The result line above the picker shows what is currently resolved (for example "Auto → reusing the DeepSeek channel").

## When it is not configured

The tool stays visible and every call returns: *Web search is not configured. Open Settings → Tools → Web Search to pick a source…*. This is deliberate — a capability that silently disappears is one you never discover. Choose **Off** if you want it gone.

## Network egress

If you run an egress allowlist (`egress.allowHosts`), add the search host — `api.deepseek.com`, `api.search.brave.com`, `open.bigmodel.cn`, or your own endpoint — or the tool reports the denial and names the host it needed.

## When changes apply

The gateway reads this configuration on every session build: a new session picks up your change right away, and an existing session picks it up when it is rebuilt (for example after changing its model).
