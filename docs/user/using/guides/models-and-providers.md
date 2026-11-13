---
title: Models and providers
type: guide
source:
  - apps/gateway/src/config/providers.ts
  - apps/gateway/src/config/routing-tiers.ts
  - apps/web/components/settings*
generated: false
verified: 2026-11-11
---

# Models and providers

> After reading: configure providers, understand model routing tiers, and know which layer to blame when "the model does not respond".

## The two provider types

| Type | When to use it | What you need to fill in |
| --- | --- | --- |
| Built-in catalog (catalog) | The vendor is in the catalog (Anthropic, OpenAI and mainstream compatible vendors) | API Key; models are picked from the catalog and capabilities (context window, image/reasoning support) come with them |
| Custom | Self-hosted gateways, private deployments, OpenAI-compatible endpoints not in the catalog | base URL, API Key, model ID; capability fields must be filled in yourself |

For the custom type the model ID is exactly the string your endpoint accepts; with the built-in catalog type you pick the catalog's own model code.

## How keys are stored

- API keys are written **encrypted** in the `providers` section of `~/.volto/config.json` (`apiKeyEnc`).
- No API response returns the plaintext; the only exception is one read when the gateway builds the model connection internally.
- So: **hand-editing `apiKeyEnc` with plaintext does not work**; to add a new provider, go through the UI or `POST /providers`.

## Model fields

| Field | What it does | When unset |
| --- | --- | --- |
| `contextWindow` | Context window size; determines the usage bar and when compaction triggers | The usage bar shows no percentage |
| `maxOutputTokens` | Maximum tokens generated per call | The provider's default |
| `reasoning` | Whether this model supports reasoning/thinking | Built-in catalog providers: follows the catalog; custom providers: treated as unsupported |
| `input` | Input modalities, for example text only | Built-in catalog providers: follows the catalog; custom providers: unknown (images are still let through, letting the vendor report the error rather than making the tool disappear) |
| `protocol` | Which wire protocol this model uses | Follows the provider's default |

## Model routing tiers

Under "Settings → Model routing" you can define a number of tiers (the factory template is premium / fast / economy); each tier points at one "provider + model". When dispatching a task to a subagent you can specify which tier to use.

- **A tier with no target assigned** (target is null) is not an error — on dispatch it falls back to the model the parent session is using.
- Deleting a tier that a subagent still references is refused (409); change the subagent first, then delete.

## Connectivity probe

Provider cards have a "Test route" button: it sends one real minimal request with the current configuration and shows "Route is usable" or "Route is not usable: &lt;reason&gt;". After changing the key or the base URL, test once — faster than hitting the error in a conversation.

## Which model generates titles

"Settings → General → Title model" lets you designate a cheap small model specifically to title new sessions. If unset, the first message is truncated instead.

## When something goes wrong

- **401 / 403** → the key is invalid or has no permission for that model; click "Test route" first.
- **404 / model does not exist** → the custom provider's model ID is misspelled, or that model code changed in the built-in catalog.
- **Replies are very slow or cut off immediately** → check whether `contextWindow` and `maxOutputTokens` are set lower than reality.
- **Images cannot be sent / the model says it cannot see the image** → the model's `input` does not declare images, or is explicitly declared text-only.

For the full set of fields see [Configuration file reference](../reference/config.md).
