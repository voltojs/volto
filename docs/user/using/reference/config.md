---
title: Configuration reference
type: reference
generated: true
source:
  - apps/gateway/src/config/*.ts
verified: 2026-11-11
---
<!-- GENERATED FILE — do not edit by hand. Run `pnpm docs:gen`; hand edits are reported as drift by `pnpm docs:check`. -->

# Configuration reference

All user-level configuration lives in `~/.volto/config.json` (`VOLTO_CONFIG_DIR` changes the directory).

Sections have different shapes: most are objects (`preferences`, `providers`, `permissions`, `egress`, `lsp`, `hooks`, `sidebar`); `projects` and `routingTiers` are arrays. Validation strictness also differs:

- `egress` / `permissions` / `lsp` / `hooks`: an unknown key makes the gateway **refuse to start** (a typo is an explicit error; that is intentional).
- `preferences` / `sidebar`: unknown keys are ignored and invalid values fall back to defaults.
- **A misspelled top-level section name does not error**: that part of the config simply has no effect. After editing, confirm it took effect in the UI or through an API.

How to edit it, when it takes effect, and how to recover from a bad edit are covered in [Permissions and approvals](../guides/permissions-and-approvals.md) and [Models and providers](../guides/models-and-providers.md); this page only lists fields.

## `browser`

The agent's built-in browser. It runs on the machine hosting the gateway and uses your locally installed Chrome/Chromium/Edge as the execution environment; Volto only depends on playwright-core as a driver and downloads no browser. It runs headless in the background by default and closes automatically once a turn ends.

| Field | Description |
| --- | --- |
| `enabled` | Whether to wire up the browser tools; defaults to true. For shared/remote deployments it is recommended to explicitly set it to false. |
| `executablePath` | Path to your local Chrome/Chromium/Edge executable. When unset, common install locations are probed automatically; if none is found the browser tools are disabled, and no browser is downloaded. |
| `headless` | Whether to run headless; defaults to true (runs in the background and takes no window). Setting it to false pops up a real browser window; keep it true when there is no display environment. |
| `idleTimeoutMs` | How long without tool calls before that session's browser is closed; defaults to 600000 (10 minutes). |
| `storageStatePath` | Optional path to a Playwright storage state file; new session browsers load it, and `browser_storage_state` writes to it. The file holds login cookies, so exclude it from git yourself. |

## `egress`

Network egress list. It constrains the three Network-port tools (`web_fetch` / `web_search` / `http_query`) and top-level navigation of the agent browser; it is not a machine-level firewall — curl run in bash and subresources inside browser pages do not go through it. The denylist wins, matching is by exact host name, and there are no wildcards.

| Field | Description |
| --- | --- |
| `allowHosts` | List of host names allowed. **Writing this field switches to whitelist mode**: every host not on the list is rejected; `[]` means reject everything. |
| `denyHosts` | List of host names to reject; takes precedence over allowHosts. |

## `hooks`

Lifecycle hooks. Each key is a lifecycle name (`session:start`, `turn:end`, `preToolUse`, `postToolUse`, `userPromptSubmit`, `preCompact`, `subagentStop`, `notification` and so on), and the value is an array of command hooks, each item accepting only `{ "type": "command", "command": "…" }`.


## `lsp`

Language server configuration. The built-in set only covers TS/JS; register other languages here. An invalid configuration refuses to start rather than silently doing nothing.

| Field | Description |
| --- | --- |
| `args` | Array of start arguments. |
| `command` | Start command, for example `rust-analyzer`. |
| `initializationParams` | Initialization parameters passed through to the language server. |
| `servers` | Indexed by **language id** (such as `typescript`, `python`), not by file extension; a file path is first mapped to a language id and then looked up in this table. |

## `permissions`

Parameter-level permission rules. The array `rules` is matched in order and the first hit takes effect; rules can only tighten permissions, never cross the sandbox boundary.

| Field | Description |
| --- | --- |
| `capability` | Matches a capability declared by the tool. |
| `commandPrefix` | Command prefix (matched token by token); only applies to tools that declare a command argument. |
| `decision` | Action once matched: `allow` / `deny` / `ask`. |
| `hostPattern` | Matches by URL host — only applies to tools that declare a URL argument. |
| `pathPattern` | Matches by path — only applies to tools that declare a path argument, which does not include `bash`. |
| `rules` | Rule array. See the table below for each rule's fields. |
| `toolName` | Matches the tool name exactly. |
| `toolPattern` | Matches the tool name by wildcard pattern. |

## `preferences`

Defaults for the interface: which permission tier a new session starts in, which language and theme to use, and which model names titles. Most fields are changed in Settings → General; editing this section by hand is usually only for bulk resets.

| Field | Description |
| --- | --- |
| `defaultPermissionMode` | Default permission tier for new sessions. |
| `lastModelId` | Last used model, used for pre-selection. |
| `lastProviderId` | Last used provider, used for pre-selection. |
| `lastReasoningEffort` | Last used reasoning effort. |
| `locale` | Interface language (zh / en). |
| `streamDensity` | Display mode: detailed (each tool becomes a card) or concise (one line per tool). |
| `theme` | Theme: light / dark / system. |
| `titleModelId` | Model used to name new sessions. |
| `titleProviderId` | Provider used to name new sessions; when unset, the first message is truncated instead. |

## `projects`

Workspace registry. An array; each element is a workspace: `id` / `name` / `path` / `createdAt`. Normally added through the interface; hand edits are not recommended.


## `providers`

Model providers and their respective model lists. apiKey is stored encrypted in `apiKeyEnc`; the plaintext is never written to disk and never appears in any API response.

| Field | Description |
| --- | --- |
| `apiKeyEnc` | The encrypted key. Typing plaintext by hand has no effect. |
| `auth` | Custom authentication method (needed by a few providers). |
| `baseURL` | Overrides the address from the catalog; null means use the default. |
| `headers` | Custom request headers. |
| `id` | Unique id of the provider on this machine. |
| `kind` | `catalog` (built-in catalog, choose by model code) or `custom` (a custom OpenAI-compatible endpoint); early records may lack this field and are treated as `custom` when read. |
| `modelCodes` | Older form: an array holding only model codes. Converted to `models` on read; new writes use `models`. |
| `models` | Model list: each item has `code`, and optionally `name` / `contextWindow` / `maxOutputTokens` / `reasoning` / `input` / `protocol`. |
| `name` | Display name. |
| `piProvider` | The built-in catalog identifier for a catalog provider. |
| `protocol` | Default wire protocol for this provider (can be overridden per model). |

## `routingTiers`

Model routing tier table. An array; each item is `{ id, label, description, target: { providerId, modelId } | null, reasoningEffort? }`; a `target` of null means unassigned, and dispatch falls back to the parent session's model.


## `sidebar`

Sidebar layout (pinned sessions, groups). Runtime state written by the interface; hand edits are overwritten on the next layout change.

