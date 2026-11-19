---
"@voltojs/core": patch
"@voltojs/tools": patch
"@voltojs/sdk": patch
"@voltojs/runtime-node": patch
"@voltojs/gateway": patch
---

Configurable web search sources. `web_search` now runs through the source configured in Settings → Tools → Web Search — DeepSeek (entered key or a reused model channel), Brave, GLM, or a user-declared REST endpoint — with encrypted per-source credentials in `config.json`, a live "test search" action, and a structured search trace (source, query, hits) in the conversation. Unconfigured sessions keep the tool visible and answer with setup guidance.

Tool visibility now budgets slots per assembled group instead of a fixed per-category table: the base 20 slots plus the actual member count of each wired group (browser, memory, code intelligence, SQLite, plan mode, web). Plan mode gets its own tier, and the web tier ranks above SQLite, so `web_search`, `web_fetch` and `save_plan` can no longer be crowded out in a fully assembled gateway session.