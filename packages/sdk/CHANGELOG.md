# @voltojs/sdk

## 0.2.3

### Patch Changes

- 5ff8161: Configurable web search sources. `web_search` now runs through the source configured in Settings → Tools → Web Search — DeepSeek (entered key or a reused model channel), Brave, GLM, or a user-declared REST endpoint — with encrypted per-source credentials in `config.json`, a live "test search" action, and a structured search trace (source, query, hits) in the conversation. Unconfigured sessions keep the tool visible and answer with setup guidance.

  Tool visibility now budgets slots per assembled group instead of a fixed per-category table: the base 20 slots plus the actual member count of each wired group (browser, memory, code intelligence, SQLite, plan mode, web). Plan mode gets its own tier, and the web tier ranks above SQLite, so `web_search`, `web_fetch` and `save_plan` can no longer be crowded out in a fully assembled gateway session.

- Updated dependencies [5ff8161]
  - @voltojs/core@0.2.3
  - @voltojs/tools@0.2.3
  - @voltojs/runtime-node@0.2.3

## 0.2.2

### Patch Changes

- Updated dependencies
  - @voltojs/core@0.2.2
  - @voltojs/runtime-node@0.2.2
  - @voltojs/tools@0.2.2

## 0.2.1

### Patch Changes

- Validate npm trusted publishing (OIDC) across every published package.
- Updated dependencies
  - @voltojs/core@0.2.1
  - @voltojs/runtime-node@0.2.1
  - @voltojs/stores@0.2.1
  - @voltojs/tools@0.2.1

## 0.2.0

### Minor Changes

- First public release of the consolidated package set.

### Patch Changes

- Updated dependencies
  - @voltojs/core@0.2.0
  - @voltojs/runtime-node@0.2.0
  - @voltojs/tools@0.2.0
  - @voltojs/stores@0.2.0

## 0.1.0

### Minor Changes

- First public release on npm.

### Patch Changes

- Updated dependencies
  - @voltojs/core@0.1.0
  - @voltojs/runtime-node@0.1.0
  - @voltojs/store-memory@0.1.0
  - @voltojs/tool-skill@0.1.0
  - @voltojs/tools-agent@0.1.0
  - @voltojs/tools-ask@0.1.0
  - @voltojs/tools-browser@0.1.0
  - @voltojs/tools-code@0.1.0
  - @voltojs/tools-common@0.1.0
  - @voltojs/tools-data@0.1.0
  - @voltojs/tools-document@0.1.0
  - @voltojs/tools-fs@0.1.0
  - @voltojs/tools-memory@0.1.0
  - @voltojs/tools-plan@0.1.0
  - @voltojs/tools-schedule@0.1.0
  - @voltojs/tools-shell@0.1.0
  - @voltojs/tools-vcs@0.1.0
  - @voltojs/tools-web@0.1.0
