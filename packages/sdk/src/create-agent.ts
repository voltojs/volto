/**
 * createAgent — SDK facade.
 *
 * Wires up the core reducer, runner, tool routing, capability gating,
 * and all adapters into a single high-level API:
 *   run(input)    — execute one turn, return final state
 *   stream(input) — yield events as they happen (async generator)
 *   resume(id, decision) — resume a HITL-paused session
 *
 * Defaults are provided for all ports except ModelPort, so the minimal
 * call is `createAgent({ modelPort })`.
 */

import type {
  ModelPort,
  ToolDefinition,
  EventSink,
  SessionStore,
  PermissionConfig,
  ToolResult,
  AgentInput,
  PendingToolCall,
  ReadFileRecord,
  FileSystem,
  Shell,
  Network,
  Message,
  CompactionConfig,
} from "@agent-core/core";
import {
  createDefaultPermissionConfig,
  extractPlainText,
  createInitialState,
} from "@agent-core/core";
import type { StepContext, ReducerState } from "@agent-core/core";
import { createRunner, type Runner, type ToolExecutor } from "@agent-core/runtime-node";
import type { RunnerOptions } from "@agent-core/runtime-node";
import {
  createFsToolExecutor,
  createShellToolExecutor,
  createNetworkToolExecutor,
} from "@agent-core/runtime-node";
import { createAutoAllowGate } from "@agent-core/runtime-node";
import type { Tool } from "@agent-core/tools-common";
import type { SubAgentExecutor } from "@agent-core/tools-agent";
import { createTaskTool } from "@agent-core/tools-agent";
import {
  createReadFileTool,
  createEditFileTool,
  createWriteFileTool,
  createLsTool,
  createGlobTool,
  createGrepTool,
  FS_TOOL_NAMES,
} from "@agent-core/tools-fs";
import { createBashTool, SHELL_TOOL_NAMES } from "@agent-core/tools-shell";
import { createWebFetchTool, createWebSearchTool, NETWORK_TOOL_NAMES } from "@agent-core/tools-web";
import {
  defaultEventSink,
  defaultTokenizer,
  createDefaultSessionStore,
} from "./defaults.js";
import { createStreamChannel } from "./stream-channel.js";

// ──────────────────────────────────────────────
// Public types
// ──────────────────────────────────────────────

export interface CreateAgentOptions {
  /** Model port — required, the LLM provider */
  modelPort: ModelPort;

  /**
   * Custom tools to register. Adapter-backed tools (fs/shell/web) are
   * auto-created when the corresponding adapter is provided.
   */
  tools?: Tool[];

  /**
   * System prompt prepended as the first message in every conversation.
   * Persists across turns and survives compaction.
   */
  systemPrompt?: string;

  /** Model name override (sent to the provider) */
  model?: string;

  /** Max tokens per model call */
  maxTokens?: number;

  /** Temperature */
  temperature?: number;

  /** Max inner-loop iterations before runaway guard fires (default: 20) */
  maxIterations?: number;

  /** Token budget per turn (default: no limit) */
  tokenBudget?: number;

  // ── Port overrides (all optional, defaults provided) ──

  /** Permission policy — defaults to sensible read/write/ask/deny */
  permissionConfig?: PermissionConfig;

  /** Session store for HITL checkpoint/resume */
  sessionStore?: SessionStore;

  /** Event sink for observability */
  eventSink?: EventSink;

  // ── Adapters — when provided, corresponding tools are auto-created ──

  /** File system adapter */
  fs?: FileSystem;

  /** Shell adapter */
  shell?: Shell;

  /** Network adapter */
  network?: Network;

  /** Available capabilities (auto-populated from injected adapters if not set) */
  capabilities?: Set<string>;

  /** Enable the task sub-agent tool */
  enableTaskTool?: boolean;

  /**
   * Compaction config — enables automatic context compression when messages
   * grow large. Uses the default character-count tokenizer if not specified.
   */
  compaction?: Omit<CompactionConfig, "tokenizer"> & { tokenizer?: CompactionConfig["tokenizer"] };
}

export interface AgentInstance {
  /** Run one turn to completion; returns the final state */
  run(input: string | AgentInput): Promise<ReducerState>;

  /** Yield events as the runner processes the turn */
  stream(
    input: string | AgentInput,
  ): AsyncGenerator<{ type: string; data: Record<string, unknown> }>;

  /**
   * Resume a HITL-paused session.
   * Tries the in-memory runner first; falls back to loading from the session store.
   */
  resume(sessionId: string, decision: "allow" | "deny"): Promise<ReducerState>;

  /** Read the latest runner state */
  getState(): ReducerState;
}

// ──────────────────────────────────────────────
// createAgent
// ──────────────────────────────────────────────

export function createAgent(opts: CreateAgentOptions): AgentInstance {
  const { modelPort } = opts;

  // ── Resolve capabilities ──────────────────
  const capabilities = opts.capabilities ?? new Set<string>();
  if (opts.fs) {
    capabilities.add("filesystem:read");
    capabilities.add("filesystem:write");
  }
  if (opts.shell) {
    capabilities.add("shell:exec");
  }
  if (opts.network) {
    capabilities.add("network:fetch");
  }
  if (opts.enableTaskTool) {
    capabilities.add("agent:task");
  }

  // ── Build adapter tools ──────────────────
  const adapterTools: Tool[] = [];
  if (opts.fs) {
    adapterTools.push(
      createReadFileTool(opts.fs),
      createEditFileTool(opts.fs),
      createWriteFileTool(opts.fs),
      createLsTool(opts.fs),
      createGlobTool(opts.fs),
      createGrepTool(opts.fs),
    );
  }
  if (opts.shell) {
    adapterTools.push(createBashTool(opts.shell));
  }
  if (opts.network) {
    adapterTools.push(createWebFetchTool(opts.network), createWebSearchTool(opts.network));
  }

  // ── Compaction config ─────────────────────
  const compactionConfig: CompactionConfig | undefined = opts.compaction
    ? { ...opts.compaction, tokenizer: opts.compaction.tokenizer ?? defaultTokenizer }
    : undefined;

  // ── Assemble all tools ────────────────────
  const allCustomTools: Tool[] = [...(opts.tools ?? [])];
  if (opts.enableTaskTool) {
    const taskTool = createTaskTool(
      createSubAgentExecutor(opts, allCustomTools, adapterTools, capabilities, compactionConfig),
    );
    allCustomTools.push(taskTool);
  }

  const allTools = [...allCustomTools, ...adapterTools];
  const toolDefs: ToolDefinition[] = allTools.map((t) => t.definition);

  // ── Step context ─────────────────────────
  const stepContext: StepContext = {
    tools: toolDefs,
    model: opts.model,
    maxTokens: opts.maxTokens,
    temperature: opts.temperature,
  };

  // ── Compose tool executor ────────────────
  const customToolMap = new Map<string, Tool>();
  for (const t of allCustomTools) {
    customToolMap.set(t.definition.name, t);
  }

  const fsExecutor = opts.fs ? createFsToolExecutor({ fs: opts.fs }) : undefined;
  const shellExecutor = opts.shell ? createShellToolExecutor({ shell: opts.shell }) : undefined;
  const networkExecutor = opts.network ? createNetworkToolExecutor({ network: opts.network }) : undefined;

  const toolExecutor: ToolExecutor = async (
    call: PendingToolCall,
    ctx: { readFiles: ReadFileRecord[]; abortSignal?: AbortSignal },
  ): Promise<ToolResult> => {
    if (fsExecutor && FS_TOOL_NAMES.has(call.name)) return fsExecutor(call, ctx);
    if (shellExecutor && SHELL_TOOL_NAMES.has(call.name)) return shellExecutor(call, ctx);
    if (networkExecutor && NETWORK_TOOL_NAMES.has(call.name)) return networkExecutor(call, ctx);
    const tool = customToolMap.get(call.name);
    if (!tool) return { modelContent: `Unknown tool: ${call.name}`, isError: true };
    return tool.handler(call.input);
  };

  // ── Permission config ─────────────────────
  const permissionConfig = opts.permissionConfig ?? createDefaultPermissionConfig();
  const approvalGate = createAutoAllowGate();

  // ── Session store ─────────────────────────
  const sessionStore = opts.sessionStore ?? createDefaultSessionStore();

  // ── Build initial messages (system prompt) ──
  const initialMessages: Message[] = [];
  if (opts.systemPrompt) {
    initialMessages.push({ role: "system", content: opts.systemPrompt });
  }

  // ── Public API ────────────────────────────

  let lastRunner: Runner | null = null;
  let lastFinalState: ReducerState | null = null;

  function createNextRunner(runnerEventSink: EventSink): Runner {
    const previousState = lastFinalState;
    lastRunner = null;
    lastFinalState = null;

    const runnerOpts: RunnerOptions = {
      modelPort,
      stepContext,
      eventSink: runnerEventSink,
      toolExecutor,
      availableCapabilities: capabilities,
      permissionConfig,
      approvalGate,
      sessionStore,
      compaction: compactionConfig,
      sessionId: `session-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    };

    if (previousState && previousState.status === "done") {
      // Carry forward conversation history. Reset turn-specific accumulator
      // fields so the new turn starts clean.
      return createRunner({
        ...runnerOpts,
        initialState: {
          ...previousState,
          status: "idle",
          pendingTools: [],
          pendingApprovalTool: undefined,
          iterationCount: 0,
          tokensUsed: 0,
          _accumulatedText: "",
          _accumulatedToolCalls: [],
        },
      });
    }

    // First turn: apply systemPrompt + maxIterations + tokenBudget
    const initStateOverrides: Partial<ReducerState> = {
      ...(opts.maxIterations !== undefined ? { maxIterations: opts.maxIterations } : {}),
      ...(opts.tokenBudget !== undefined ? { tokenBudget: opts.tokenBudget } : {}),
      ...(initialMessages.length > 0 ? { messages: [...initialMessages] } : {}),
    };
    const initState = createInitialState(
      Object.keys(initStateOverrides).length > 0 ? initStateOverrides : undefined,
    );

    return createRunner({
      ...runnerOpts,
      initialState: initState,
    });
  }

  return {
    async run(input: string | AgentInput): Promise<ReducerState> {
      const agentInput = normalizeInput(input);
      const runner = createNextRunner(opts.eventSink ?? defaultEventSink);
      lastRunner = runner;
      const finalState = await runner.run(agentInput);
      lastFinalState = finalState;
      return finalState;
    },

    async *stream(
      input: string | AgentInput,
    ): AsyncGenerator<{ type: string; data: Record<string, unknown> }> {
      const agentInput = normalizeInput(input);
      const channel = createStreamChannel();
      const runner = createNextRunner(channel.eventSink);
      lastRunner = runner;

      let runError: unknown;
      const runPromise = runner.run(agentInput).then((finalState) => {
        lastFinalState = finalState;
        channel.done();
      }).catch((err) => {
        runError = err;
        channel.done();
      });

      yield* channel.events();
      // Ensure runner completes and errors propagate.
      // The finally-less approach: yield* returns when consumer breaks or
      // generator is garbage-collected; we await runPromise after yield*
      // returns to catch any pending errors.
      await runPromise;
      if (runError) throw runError;
    },

    async resume(sessionId: string, decision: "allow" | "deny"): Promise<ReducerState> {
      // Try the in-memory runner first (same-process resume)
      if (lastRunner) {
        try {
          const finalState = await lastRunner.resume(sessionId, decision);
          lastFinalState = finalState;
          return finalState;
        } catch {
          // Runner doesn't have this session — fall through to store-based resume
        }
      }

      // Cross-process resume: load from session store and create a fresh runner
      const snapshot = await sessionStore.load(sessionId);
      if (!snapshot) {
        throw new Error(`Session not found: ${sessionId}`);
      }

      const restoredState = snapshot.state as ReducerState;
      if (restoredState.status !== "waiting_for_approval") {
        throw new Error(
          `Cannot resume session ${sessionId}: expected "waiting_for_approval" but got "${restoredState.status}"`,
        );
      }
      if (!restoredState.pendingApprovalTool) {
        throw new Error(
          `Cannot resume session ${sessionId}: missing pendingApprovalTool`,
        );
      }

      const resumeRunner = createRunner({
        modelPort,
        stepContext,
        eventSink: opts.eventSink ?? defaultEventSink,
        toolExecutor,
        availableCapabilities: capabilities,
        permissionConfig,
        approvalGate,
        sessionStore,
        compaction: compactionConfig,
        sessionId,
        initialState: restoredState,
      });

      lastRunner = resumeRunner;
      const finalState = await resumeRunner.resume(sessionId, decision);
      lastFinalState = finalState;
      return finalState;
    },

    getState(): ReducerState {
      if (lastFinalState) return lastFinalState;
      if (lastRunner) return lastRunner.getState();
      throw new Error("No active session. Run a turn first.");
    },
  };
}

// ──────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────

function normalizeInput(input: string | AgentInput): AgentInput {
  if (typeof input === "string") {
    return { type: "user_message", content: input };
  }
  return input;
}

/**
 * Create a SubAgentExecutor that spins up a fresh Runner with isolated state,
 * shared ModelPort and tools (without task tools to prevent recursion).
 * Sub-agent events are forwarded to the parent's event sink for observability.
 */
function createSubAgentExecutor(
  opts: CreateAgentOptions,
  parentCustomTools: Tool[],
  parentAdapterTools: Tool[],
  capabilities: Set<string>,
  compactionConfig?: CompactionConfig,
): SubAgentExecutor {
  return async (message: string): Promise<string> => {
    const subCustomTools = parentCustomTools.filter(
      (t) => t.definition.name !== "task",
    );
    const subAllTools = [...subCustomTools, ...parentAdapterTools];
    const subToolDefs: ToolDefinition[] = subAllTools.map((t) => t.definition);

    const subCustomToolMap = new Map<string, Tool>();
    for (const t of subCustomTools) {
      subCustomToolMap.set(t.definition.name, t);
    }

    const subFsExecutor = opts.fs ? createFsToolExecutor({ fs: opts.fs }) : undefined;
    const subShellExecutor = opts.shell ? createShellToolExecutor({ shell: opts.shell }) : undefined;
    const subNetworkExecutor = opts.network ? createNetworkToolExecutor({ network: opts.network }) : undefined;

    const subExecutor: ToolExecutor = async (call, ctx) => {
      if (subFsExecutor && FS_TOOL_NAMES.has(call.name)) return subFsExecutor(call, ctx);
      if (subShellExecutor && SHELL_TOOL_NAMES.has(call.name)) return subShellExecutor(call, ctx);
      if (subNetworkExecutor && NETWORK_TOOL_NAMES.has(call.name)) return subNetworkExecutor(call, ctx);
      const tool = subCustomToolMap.get(call.name);
      if (!tool) return { modelContent: `Unknown tool: ${call.name}`, isError: true };
      return tool.handler(call.input);
    };

    const subCapabilities = new Set(capabilities);
    subCapabilities.delete("agent:task");

    const subStepContext: StepContext = {
      tools: subToolDefs,
      model: opts.model,
      maxTokens: opts.maxTokens,
      temperature: opts.temperature,
    };

    const subRunner = createRunner({
      modelPort: opts.modelPort,
      stepContext: subStepContext,
      toolExecutor: subExecutor,
      availableCapabilities: subCapabilities,
      permissionConfig: opts.permissionConfig,
      approvalGate: createAutoAllowGate(),
      eventSink: opts.eventSink,
      sessionStore: createDefaultSessionStore(),
      compaction: compactionConfig,
      sessionId: `sub-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    });

    const finalState = await subRunner.run({
      type: "user_message",
      content: message,
    });

    const lastMsg = finalState.messages[finalState.messages.length - 1];
    if (lastMsg && lastMsg.role === "assistant") {
      return extractPlainText(lastMsg);
    }
    return "";
  };
}
