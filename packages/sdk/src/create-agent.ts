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
} from "@agent-core/core";
import {
  createDefaultPermissionConfig,
  extractPlainText,
} from "@agent-core/core";
import type { StepContext, ReducerState } from "@agent-core/core";
import { createRunner, type Runner, type ToolExecutor } from "@agent-core/runtime-node";
import type { RunnerOptions } from "@agent-core/runtime-node";
import {
  createFsToolExecutor,
  createShellToolExecutor,
  createNetworkToolExecutor,
} from "@agent-core/runtime-node";
import {
  createAutoAllowGate,
} from "@agent-core/runtime-node";
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
} from "@agent-core/tools-fs";
import { createBashTool } from "@agent-core/tools-shell";
import { createWebFetchTool, createWebSearchTool } from "@agent-core/tools-web";
import {
  defaultEventSink,
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

  /** System prompt prepended to every conversation */
  systemPrompt?: string;

  /** Model name override (sent to the provider) */
  model?: string;

  /** Max tokens per model call */
  maxTokens?: number;

  /** Temperature */
  temperature?: number;

  /** Max inner-loop iterations before runaway guard fires */
  maxIterations?: number;

  /** Token budget per turn */
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

  /** Working directory for file system sandboxing */
  cwd?: string;

  /** Available capabilities (auto-populated from injected adapters if not set) */
  capabilities?: Set<string>;

  /** Enable the task sub-agent tool */
  enableTaskTool?: boolean;
}

export interface AgentInstance {
  /** Run one turn to completion; returns the final state */
  run(input: string | AgentInput): Promise<ReducerState>;

  /** Yield events as the runner processes the turn */
  stream(
    input: string | AgentInput,
  ): AsyncGenerator<{ type: string; data: Record<string, unknown> }>;

  /** Resume a HITL-paused session */
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

  // ── Build adapter tools (schema-only, no real adapter needed) ──
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

  // ── Assemble all tools ────────────────────
  const allCustomTools: Tool[] = [...(opts.tools ?? [])];
  if (opts.enableTaskTool) {
    const taskTool = createTaskTool(
      createSubAgentExecutor(opts, allCustomTools, adapterTools, capabilities),
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
  // Custom tools (from opts.tools + task) are executed via their handler.
  // Adapter tools are routed to their specific executors.
  const customToolMap = new Map<string, Tool>();
  for (const t of allCustomTools) {
    customToolMap.set(t.definition.name, t);
  }

  // Build adapter executors
  const fsExecutor = opts.fs
    ? createFsToolExecutor({ fs: opts.fs })
    : undefined;
  const shellExecutor = opts.shell
    ? createShellToolExecutor({ shell: opts.shell })
    : undefined;
  const networkExecutor = opts.network
    ? createNetworkToolExecutor({ network: opts.network })
    : undefined;

  const toolExecutor: ToolExecutor = async (
    call: PendingToolCall,
    ctx: { readFiles: ReadFileRecord[]; abortSignal?: AbortSignal },
  ): Promise<ToolResult> => {
    // Route to adapter executors first
    if (fsExecutor && isFsTool(call.name)) {
      return fsExecutor(call, ctx);
    }
    if (shellExecutor && isShellTool(call.name)) {
      return shellExecutor(call, ctx);
    }
    if (networkExecutor && isNetworkTool(call.name)) {
      return networkExecutor(call, ctx);
    }

    // Fall back to custom tool map
    const tool = customToolMap.get(call.name);
    if (!tool) {
      return { modelContent: `Unknown tool: ${call.name}`, isError: true };
    }
    return tool.handler(call.input);
  };

  // ── Permission config ─────────────────────
  const permissionConfig = opts.permissionConfig ?? createDefaultPermissionConfig();
  // Default approval gate: auto-allow (user can override via opts in the future)
  const approvalGate = createAutoAllowGate();

  // ── Session store ─────────────────────────
  const sessionStore = opts.sessionStore ?? createDefaultSessionStore();

  // ── Create runners ───────────────────────
  let runnerCounter = 0;

  // ── Public API ────────────────────────────

  let lastRunner: Runner | null = null;
  let lastFinalState: ReducerState | null = null;

  /**
   * Create a runner for the next turn. If the previous turn completed,
   * carry the state forward (preserving conversation history).
   */
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
      sessionId: `session-${++runnerCounter}`,
    };

    if (previousState && previousState.status === "done") {
      // Carry forward conversation history from the previous turn.
      // CreateInitialState with overridden messages so the new turn
      // starts with the full conversation history.
      return createRunner({
        ...runnerOpts,
        initialState: {
          ...previousState,
          // Reset turn-specific fields for the new turn
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

    return createRunner(runnerOpts);
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
      await runPromise;
      if (runError) throw runError;
    },

    async resume(sessionId: string, decision: "allow" | "deny"): Promise<ReducerState> {
      if (!lastRunner) {
        throw new Error("No active session to resume. Run a turn first.");
      }
      const finalState = await lastRunner.resume(sessionId, decision);
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

function isFsTool(name: string): boolean {
  return name === "read_file" || name === "edit_file" || name === "write_file" ||
    name === "ls" || name === "glob" || name === "grep";
}

function isShellTool(name: string): boolean {
  return name === "bash";
}

function isNetworkTool(name: string): boolean {
  return name === "web_fetch" || name === "web_search";
}


/**
 * Create a SubAgentExecutor that spins up a fresh Runner with isolated state,
 * shared ModelPort and tools (without task tools to prevent recursion).
 */
function createSubAgentExecutor(
  opts: CreateAgentOptions,
  parentCustomTools: Tool[],
  parentAdapterTools: Tool[],
  capabilities: Set<string>,
): SubAgentExecutor {
  return async (message: string): Promise<string> => {
    // Sub-agent gets custom tools (without task) + adapter tools
    const subCustomTools = parentCustomTools.filter(
      (t) => t.definition.name !== "task",
    );
    const subAllTools = [...subCustomTools, ...parentAdapterTools];
    const subToolDefs: ToolDefinition[] = subAllTools.map((t) => t.definition);

    // Build sub-agent custom tool map
    const subCustomToolMap = new Map<string, Tool>();
    for (const t of subCustomTools) {
      subCustomToolMap.set(t.definition.name, t);
    }

    // Build sub-agent executors (same adapters, no recursive task)
    const subFsExecutor = opts.fs ? createFsToolExecutor({ fs: opts.fs }) : undefined;
    const subShellExecutor = opts.shell ? createShellToolExecutor({ shell: opts.shell }) : undefined;
    const subNetworkExecutor = opts.network ? createNetworkToolExecutor({ network: opts.network }) : undefined;

    const subExecutor: ToolExecutor = async (call, ctx) => {
      if (subFsExecutor && isFsTool(call.name)) return subFsExecutor(call, ctx);
      if (subShellExecutor && isShellTool(call.name)) return subShellExecutor(call, ctx);
      if (subNetworkExecutor && isNetworkTool(call.name)) return subNetworkExecutor(call, ctx);
      const tool = subCustomToolMap.get(call.name);
      if (!tool) return { modelContent: `Unknown tool: ${call.name}`, isError: true };
      return tool.handler(call.input);
    };

    // Sub capabilities: everything except agent:task
    const subCapabilities = new Set(capabilities);
    subCapabilities.delete("agent:task");

    const subStepContext: StepContext = {
      tools: subToolDefs,
      model: opts.model,
      maxTokens: opts.maxTokens,
      temperature: opts.temperature,
    };

    let subCounter = 0;
    const subRunner = createRunner({
      modelPort: opts.modelPort,
      stepContext: subStepContext,
      toolExecutor: subExecutor,
      availableCapabilities: subCapabilities,
      permissionConfig: opts.permissionConfig,
      approvalGate: createAutoAllowGate(),
      sessionStore: createDefaultSessionStore(),
      sessionId: `sub-session-${++subCounter}`,
    });

    const finalState = await subRunner.run({
      type: "user_message",
      content: message,
    });

    // Extract final text output from the last assistant message
    const lastMsg = finalState.messages[finalState.messages.length - 1];
    if (lastMsg && lastMsg.role === "assistant") {
      return extractPlainText(lastMsg);
    }
    return "";
  };
}
