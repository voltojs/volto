---
title: Models and providers
type: guide
source:
  - apps/gateway/src/config/providers.ts
  - apps/gateway/src/config/routing-tiers.ts
  - apps/web/components/settings*
generated: false
verified: 2026-11-17
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
| `thinkingLevelMap` | Per-tier mapping from a reasoning tier to the value sent to the endpoint (see "Reasoning levels" below) | Follows the catalog; for a custom provider, an unmapped tier sends its own name |

## Reasoning levels

Open a model row in "Settings → Models" and expand it: the "Reasoning levels" section lets you change, per model, which value each reasoning tier is sent as. Turn on "Enable reasoning level overrides" to edit the rows.

This is what you need it for when a compatible endpoint does not accept the standard tier names — for example one that wants `enabled` / `disabled` instead of `high` / `off`, or a tier name the built-in catalog does not list for that model.

The full set of tiers is seven: `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max`. Each row has three states:

| Row state | What it means |
| --- | --- |
| A value typed in | The tier is supported and is sent as exactly that string. |
| "Unsupported" ticked | The tier is declared not supported: it disappears from the reasoning picker in the chat composer, and a request that still names it is refused with an explicit error rather than quietly switched to another tier. |
| Empty value | Inherits the default — the catalog's own value for a built-in provider; for a custom provider, a tier the endpoint can use sends its own name and `off` sends no reasoning parameter at all. |

- **Adding a tier seeds its value.** When you pick a tier in the "Tier" column, or press "Add tier", the value box comes pre-filled with the tier's name (`xhigh` and `max` have no built-in mapping for most models). Clearing the box back to empty means inherit again; the `off` row shows "No thinking" when nothing is mapped to it.
- **Turning the master toggle off removes every override** for that model, it does not hide them; switching it back on re-seeds from what was there before you turned it off. Collapsing and reopening the row reloads the saved configuration.
- **Editing a tier value while the model's "Reasoning" checkbox is off turns reasoning on for you**, and the row shows "reasoning enabled automatically". Without that the setting would be stored but never used. While reasoning is off the section shows "takes effect once reasoning is enabled".

Two boundaries worth knowing:

- **You change the value, not the field.** The value goes into whichever reasoning parameter your endpoint's protocol already uses (`reasoning_effort`, `thinking`, `reasoning.effort`, and so on); you cannot rename that field or restructure it here.
- **A numeric token budget is not a tier value.** Tiers map to text values only; capping reasoning tokens is not configurable in this section.

The values you see in the placeholders are the effective ones for that model, so you can read off what will actually be sent without saving anything.

## Model routing tiers

Under "Settings → Model routing" you can define a number of tiers (the factory template is premium / fast / economy); each tier points at one "provider + model". When dispatching a task to a subagent you can specify which tier to use.

- **A tier with no target assigned** (target is null) is not an error — on dispatch it falls back to the model the parent session is using.
- Deleting a tier that a subagent still references is refused (409); change the subagent first, then delete.

## Connectivity probe

Provider cards have a "Test route" button: it checks the current configuration (model resolvable, key present, protocol known) and shows "Route is usable" or "Route is not usable: &lt;reason&gt;". It does not send a request to the provider; the first real request happens in a conversation.

## Which model generates titles

"Settings → General → Title model" lets you designate a cheap small model specifically to title new sessions. If unset, the first message is truncated instead.

## When something goes wrong

- **401 / 403** → the key is invalid or has no permission for that model; click "Test route" first.
- **404 / model does not exist** → the custom provider's model ID is misspelled, or that model code changed in the built-in catalog.
- **Replies are very slow or cut off immediately** → check whether `contextWindow` and `maxOutputTokens` are set lower than reality.
- **Images cannot be sent / the model says it cannot see the image** → the model's `input` does not declare images, or is explicitly declared text-only.
- **The reasoning tier you set has no effect** → check that the model's "Reasoning" checkbox is on and that the tier is not ticked "Unsupported"; an unsupported tier is refused by name in the error rather than replaced.

For the full set of fields see [Configuration file reference](../reference/config.md).
