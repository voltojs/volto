---
title: SDK 导出清单
type: reference
generated: true
source:
  - packages/sdk/src/index.ts
verified: 2026-11-11
---
<!-- GENERATED FILE — do not edit by hand.
     由 `pnpm docs:gen` 从代码与下面的 notes 文件生成；手改会被 `pnpm docs:check` 判为漂移。
     要改内容：改 notes JSON 或改代码，然后重新生成。 -->

# SDK 导出清单

`@volto/sdk` 的公开导出。逐项语义见 [SDK 导读](./sdk-api.md)。

| 导出 | 分类 |
| --- | --- |
| `// M8: new port defaults
  defaultToolSource` | 其它 |
| `AgentEntry` | 其它 |
| `AgentInput` | 其它 |
| `AgentInstance` | 其它 |
| `AgentScanResult` | 其它 |
| `AgentSpec` | 其它 |
| `AgentStore` | 其它 |
| `AssembledSubAgent` | 其它 |
| `AssemblyPresence` | 其它 |
| `AuditEntry` | 其它 |
| `AuditSink` | 其它 |
| `BUILTIN_AGENTS` | 其它 |
| `BUILTIN_EXPLORE` | 其它 |
| `BUILTIN_GENERAL_PURPOSE` | 其它 |
| `BackgroundCollectResult` | 其它 |
| `BackgroundRegistry` | 其它 |
| `Checkpoint` | 其它 |
| `CollectedPlugins` | 其它 |
| `CompactNowResult` | 其它 |
| `CompactionBusyError` | 其它 |
| `ConfigLayer` | 其它 |
| `ConfigSource` | 其它 |
| `CostMeterOptions` | 模型 |
| `CostMeterResult` | 模型 |
| `CreateAgentOptions` | 其它 |
| `CreateAgentStoreOptions` | 其它 |
| `DEFAULT_SESSION_SECRET_ENV_PATTERNS` | 其它 |
| `DebuggerOptions` | 其它 |
| `EXPLORE_NAME` | 其它 |
| `EventSink` | 其它 |
| `FileChangedInput` | 其它 |
| `FileWatchEvent` | 其它 |
| `FileWatchRegistration` | 其它 |
| `FileWatcher` | 其它 |
| `GENERAL_PURPOSE_NAME` | 其它 |
| `Hook` | 组合 |
| `HookContext` | 组合 |
| `HookHandler` | 组合 |
| `HookLifecycle` | 组合 |
| `HookOutcome` | 组合 |
| `HookPatch` | 组合 |
| `LoadAgentSpecOptions` | 其它 |
| `MergeStrategy` | 其它 |
| `ModelPort` | 模型 |
| `ModelRouterOptions` | 模型 |
| `OrchestratorOptions` | 其它 |
| `PermissionConfig` | 其它 |
| `Plugin` | 其它 |
| `PluginAgentSpec` | 其它 |
| `PluginCommand` | 其它 |
| `PluginHook` | 其它 |
| `PluginRegistry` | 其它 |
| `PluginSkill` | 其它 |
| `PricingEntry` | 模型 |
| `PricingTable` | 模型 |
| `ReducerState` | 其它 |
| `ResolvedAgentSpec` | 其它 |
| `ResolvedConfig` | 其它 |
| `ResolvedFrom` | 其它 |
| `ResolvedPorts` | 其它 |
| `ResourceLoader` | 其它 |
| `Runner` | 其它 |
| `RunnerOptions` | 其它 |
| `ScanAgentSourcesOptions` | 其它 |
| `SessionStore` | 其它 |
| `Skill` | 其它 |
| `SlashCommand` | 其它 |
| `StateDiff` | 其它 |
| `StreamChannel` | 其它 |
| `TimeTravelDebugger` | 其它 |
| `ToolDefinition` | 其它 |
| `ToolExecutor` | 其它 |
| `ToolRegistry` | 其它 |
| `ToolResult` | 其它 |
| `ToolScopeConfig` | 其它 |
| `ToolSource` | 其它 |
| `ToolVisibility` | 其它 |
| `assembleSubAgent` | 门面 |
| `buildDefaultToolVisibility` | 其它 |
| `collectPlugins` | 其它 |
| `createAgent` | 门面 |
| `createAgentStore` | 其它 |
| `createBackgroundRegistry` | 门面 |
| `createCostMeter` | 模型 |
| `createDefaultCache` | 其它 |
| `createDefaultMemoryStore` | 其它 |
| `createDefaultSessionStore` | 其它 |
| `createInitialState` | 其它 |
| `createModelRouter` | 模型 |
| `createOrchestrator` | 组合 |
| `createPluginRegistry` | 组合 |
| `createPluginToolSource` | 组合 |
| `createStreamChannel` | 其它 |
| `createTimeTravelDebugger` | 其它 |
| `defaultAuditSink` | 其它 |
| `defaultClock` | 其它 |
| `defaultEmbedder` | 其它 |
| `defaultEventSink` | 其它 |
| `defaultId` | 其它 |
| `defaultPolicyEngine` | 其它 |
| `defaultRandom` | 其它 |
| `defaultSandbox` | 其它 |
| `defaultScheduler` | 其它 |
| `defaultSecrets` | 其它 |
| `defaultTelemetry` | 其它 |
| `defaultTokenizer` | 其它 |
| `diffState` | 其它 |
| `findBuiltInAgent` | 其它 |
| `findCommand` | 其它 |
| `loadAgentSpec` | 其它 |
| `mergeConfig` | 其它 |
| `mergeQueuedEdit` | 门面 |
| `parseArgs` | 其它 |
| `readConversation` | 其它 |
| `readTrajectory` | 其它 |
| `renderCommand` | 其它 |
| `resolveAgentSpec` | 其它 |
| `runHookPipeline` | 其它 |
| `scanAgentSources` | 其它 |

> 这张表由 `pnpm docs:gen` 生成。**`@volto/sdk` 目前不发布 npm**：集成方式是 workspace 依赖或源码引用，因此没有版本号与 peer 依赖契约。
