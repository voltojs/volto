---
title: SDK 导出清单
type: reference
generated: true
source:
  - packages/sdk/src/index.ts
verified: 2026-11-11
---
<!-- GENERATED FILE — do not edit by hand. Run `pnpm docs:gen`; hand edits are reported as drift by `pnpm docs:check`. -->

# SDK 导出清单

`@voltojs/sdk` 的公开导出。逐项语义见 [SDK 导读](./sdk-api.md)。

## 值（函数 / 常量 / 类）· 53 个

| 导出 |
| --- |
| `ACCEPTANCE_VERIFY_TIMEOUT_MS` |
| `BUILTIN_AGENTS` |
| `BUILTIN_EXPLORE` |
| `BUILTIN_GENERAL_PURPOSE` |
| `CompactionBusyError` |
| `DEFAULT_ACCEPTANCE_MAX_REWORKS` |
| `DEFAULT_SESSION_SECRET_ENV_PATTERNS` |
| `EXPLORE_NAME` |
| `GENERAL_PURPOSE_NAME` |
| `MAX_ACCEPTANCE_REWORKS` |
| `assembleSubAgent` |
| `buildDefaultToolVisibility` |
| `collectPlugins` |
| `createAgent` |
| `createAgentStore` |
| `createBackgroundRegistry` |
| `createCostMeter` |
| `createDefaultCache` |
| `createDefaultMemoryStore` |
| `createDefaultSessionStore` |
| `createInitialState` |
| `createModelRouter` |
| `createPluginRegistry` |
| `createPluginToolSource` |
| `createStreamChannel` |
| `createTimeTravelDebugger` |
| `defaultAuditSink` |
| `defaultClock` |
| `defaultEmbedder` |
| `defaultEventSink` |
| `defaultId` |
| `defaultPolicyEngine` |
| `defaultRandom` |
| `defaultSandbox` |
| `defaultScheduler` |
| `defaultSecrets` |
| `defaultTelemetry` |
| `defaultTokenizer` |
| `defaultToolSource` |
| `diffState` |
| `findBuiltInAgent` |
| `findCommand` |
| `loadAgentSpec` |
| `mergeConfig` |
| `mergeQueuedEdit` |
| `parseArgs` |
| `readConversation` |
| `readTrajectory` |
| `renderCommand` |
| `resolveAgentSpec` |
| `runHookPipeline` |
| `scanAgentSources` |
| `sse` |

## 类型 · 68 个

| 导出 |
| --- |
| `AgentEntry` |
| `AgentInput` |
| `AgentInstance` |
| `AgentScanResult` |
| `AgentSpec` |
| `AgentStore` |
| `AssembledSubAgent` |
| `AssemblyPresence` |
| `AuditEntry` |
| `AuditSink` |
| `BackgroundCollectResult` |
| `BackgroundRegistry` |
| `Checkpoint` |
| `CollectedPlugins` |
| `CompactNowResult` |
| `ConfigLayer` |
| `ConfigSource` |
| `CostMeterOptions` |
| `CostMeterResult` |
| `CreateAgentOptions` |
| `CreateAgentStoreOptions` |
| `DebuggerOptions` |
| `EventSink` |
| `FileChangedInput` |
| `FileWatchEvent` |
| `FileWatchRegistration` |
| `FileWatcher` |
| `Hook` |
| `HookContext` |
| `HookHandler` |
| `HookLifecycle` |
| `HookOutcome` |
| `HookPatch` |
| `LoadAgentSpecOptions` |
| `MergeStrategy` |
| `ModelPort` |
| `ModelRouterOptions` |
| `PermissionConfig` |
| `Plugin` |
| `PluginAgentSpec` |
| `PluginCommand` |
| `PluginHook` |
| `PluginRegistry` |
| `PluginSkill` |
| `PricingEntry` |
| `PricingTable` |
| `ReducerState` |
| `ResolvedAgentSpec` |
| `ResolvedConfig` |
| `ResolvedFrom` |
| `ResolvedPorts` |
| `ResourceLoader` |
| `Runner` |
| `RunnerOptions` |
| `ScanAgentSourcesOptions` |
| `SessionStore` |
| `Skill` |
| `SlashCommand` |
| `StateDiff` |
| `StreamChannel` |
| `TimeTravelDebugger` |
| `ToolDefinition` |
| `ToolExecutor` |
| `ToolRegistry` |
| `ToolResult` |
| `ToolScopeConfig` |
| `ToolSource` |
| `ToolVisibility` |

> 这张表由 `pnpm docs:gen` 生成。`@voltojs/sdk` 与其他包同版本发布到 npm 公共 registry（`npm i @voltojs/sdk`，见 [发布与安装](../guides/publishing.md)），要求 **Node ≥ 22**，**只提供 ESM 入口**：`import` 或动态 `import()` 可用，`require()` 不能直接加载它。
