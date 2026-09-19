/**
 * Multi-agent orchestrator — interprets TopologySpec and runs
 * supervisor / pipeline topologies using isolated sub-agent runners.
 *
 * Reuses the same isolation pattern as createSubAgentExecutor:
 * each node gets its own Runner with fresh state, shared ModelPort,
 * and a subset of tools (no "task" to prevent recursion).
 */

import type {
  TopologySpec,
  TopologyNodeSpec,
  TopologyResult,
} from "@volto/core";
import type {
  CreateAgentOptions,
} from "./create-agent.js";
import type {
  ToolDefinition,
  StepContext,
  EventSink,
  ReducerState,
  Message,
} from "@volto/core";
import type { Tool } from "@volto/tools-common";
import { createRunner } from "@volto/runtime-node";
import type { Runner, RunnerOptions, ToolExecutor } from "@volto/runtime-node";
import { createAutoAllowGate } from "@volto/runtime-node";
import { createInitialState, ceilingOf } from "@volto/core";
import {
  createFsToolExecutor,
  createShellToolExecutor,
  createNetworkToolExecutor,
} from "@volto/runtime-node";
import { FS_EXECUTOR_TOOL_NAMES } from "@volto/tools-fs";
import { SHELL_TOOL_NAMES } from "@volto/tools-shell";
import { NETWORK_TOOL_NAMES } from "@volto/tools-web";

export interface OrchestratorOptions {
  /** The topology spec to execute */
  topology: TopologySpec;
  /** Agent options to use for creating sub-runners (ports + config) */
  agentOpts: CreateAgentOptions;
  /** Custom tools available to nodes */
  customTools?: Tool[];
  /** Adapter tools (fs/shell/network) */
  adapterTools?: Tool[];
  /** Capabilities set */
  capabilities?: Set<string>;
}

/**
 * Create an orchestrator for the given topology.
 * Returns a function that runs the topology with the given input.
 */
export function createOrchestrator(opts: OrchestratorOptions): {
  run(input: string): Promise<TopologyResult>;
} {
  const {
    topology,
    agentOpts,
    customTools = [],
    adapterTools = [],
    capabilities = new Set(),
  } = opts;

  function buildNodeRunner(
    node: TopologyNodeSpec,
    eventSink?: EventSink,
  ): Runner {
    const allTools = [...customTools, ...adapterTools];
    const toolDefs: ToolDefinition[] = allTools.map((t) => t.definition);

    const toolMap = new Map<string, Tool>();
    for (const t of allTools) toolMap.set(t.definition.name, t);

    const fsExecutor = agentOpts.fs
      ? createFsToolExecutor({ fs: agentOpts.fs })
      : undefined;
    const shellExecutor = agentOpts.shell
      ? createShellToolExecutor({ shell: agentOpts.shell })
      : undefined;
    const networkExecutor = agentOpts.network
      ? createNetworkToolExecutor({ network: agentOpts.network })
      : undefined;

    const executor: ToolExecutor = async (call, ctx) => {
      // FS_EXECUTOR_TOOL_NAMES, not FS_TOOL_NAMES: the latter also lists
      // FileWatcher-backed watch tools that createFsToolExecutor does not
      // implement (they would short-circuit to "Unknown tool").
      if (fsExecutor && FS_EXECUTOR_TOOL_NAMES.has(call.name)) return fsExecutor(call, ctx);
      if (shellExecutor && SHELL_TOOL_NAMES.has(call.name)) return shellExecutor(call, ctx);
      if (networkExecutor && NETWORK_TOOL_NAMES.has(call.name)) return networkExecutor(call, ctx);
      const tool = toolMap.get(call.name);
      if (!tool) return { modelContent: `Unknown tool: ${call.name}`, isError: true };
      return tool.handler(call.input);
    };

    const nodeCaps = new Set(capabilities);
    nodeCaps.delete("agent:task");

    const stepCtx: StepContext = {
      tools: toolDefs,
      model: node.model ?? topology.model ?? agentOpts.model,
      maxTokens: agentOpts.maxTokens,
      temperature: agentOpts.temperature,
    };

    const runnerOpts: RunnerOptions = {
      modelPort: agentOpts.modelPort!,
      stepContext: stepCtx,
      toolExecutor: executor,
      availableCapabilities: nodeCaps,
      permissionConfig: agentOpts.permissionConfig,
      // Same ceiling derivation as createAgent's Runners: with a policy in
      // force, above-ceiling tools leave the node's visible set instead of
      // only being refused after the model tries them.
      riskCeiling: agentOpts.permissionConfig
        ? ceilingOf(agentOpts.permissionConfig.sandbox)
        : undefined,
      approvalGate: createAutoAllowGate(),
      eventSink,
      sessionId: `topo-${topology.name}-${node.name}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      initialState: createInitialState({
        messages: [{ id: `topo-${topology.name}-${node.name}`, role: "system", content: node.systemPrompt }] as Message[],
      }),
    };

    return createRunner(runnerOpts);
  }

  function extractText(state: ReducerState): string {
    const lastMsg = state.messages[state.messages.length - 1];
    if (lastMsg && lastMsg.role === "assistant") {
      const textBlocks = lastMsg.content.filter(
        (b): b is { type: "text"; text: string } => b.type === "text",
      );
      return textBlocks.map((b) => b.text).join("");
    }
    return "";
  }

  /**
   * Run a pipeline topology: nodes execute sequentially in the order
   * specified by `topology.order`. Each node receives the previous node's
   * output as input. The final output is the last node's result.
   *
   * Note: This is a simple sequential chain. No parallelization, branching,
   * or conditional routing is performed.
   */
  async function runPipeline(input: string): Promise<TopologyResult> {
    const nodeOutputs: Record<string, string> = {};
    let currentInput = input;

    for (const nodeName of topology.order) {
      const node = topology.nodes.find((n) => n.name === nodeName);
      if (!node) throw new Error(`Node not found in topology: ${nodeName}`);

      const runner = buildNodeRunner(node);
      const state = await runner.run({
        type: "user_message",
        content: currentInput,
      });

      const output = extractText(state);
      nodeOutputs[nodeName] = output;
      currentInput = output;
    }

    const lastNodeName = topology.order[topology.order.length - 1]!;
    return {
      output: nodeOutputs[lastNodeName] ?? "",
      nodeOutputs,
    };
  }

  /**
   * Run a supervisor topology: the first node (supervisor) processes the
   * input, then its output is broadcast to all worker nodes in parallel.
   * The final result aggregates the supervisor output and all worker outputs.
   *
   * Note: This is a simplified "broadcast + aggregate" pattern. The supervisor
   * node's output is sent verbatim to every worker; there is no routing logic
   * that selectively dispatches work based on the supervisor's output content.
   * True routing-based supervisor topologies require an additional parsing
   * step in the orchestrator to interpret the supervisor's routing decisions.
   */
  async function runSupervisor(input: string): Promise<TopologyResult> {
    const nodeOutputs: Record<string, string> = {};
    const supervisorName = topology.order[0]!;
    const workerNames = topology.order.slice(1);

    // Run supervisor
    const supervisorNode = topology.nodes.find((n) => n.name === supervisorName);
    if (!supervisorNode) throw new Error(`Supervisor node not found: ${supervisorName}`);

    const supervisorRunner = buildNodeRunner(supervisorNode);
    const supervisorState = await supervisorRunner.run({
      type: "user_message",
      content: input,
    });

    const supervisorOutput = extractText(supervisorState);
    nodeOutputs[supervisorName] = supervisorOutput;

    // Run workers in parallel — each receives the supervisor's output
    const workerResults = await Promise.all(
      workerNames.map(async (workerName) => {
        const workerNode = topology.nodes.find((n) => n.name === workerName);
        if (!workerNode) throw new Error(`Worker node not found: ${workerName}`);

        const workerRunner = buildNodeRunner(workerNode);
        const workerState = await workerRunner.run({
          type: "user_message",
          content: supervisorOutput,
        });

        return { name: workerName, output: extractText(workerState) };
      }),
    );

    for (const r of workerResults) {
      nodeOutputs[r.name] = r.output;
    }

    // Aggregate: supervisor output + all worker outputs
    const aggregated = [
      supervisorOutput,
      ...workerResults.map((r) => `[${r.name}]: ${r.output}`),
    ].join("\n\n");

    return {
      output: aggregated,
      nodeOutputs,
    };
  }

  return {
    async run(input: string): Promise<TopologyResult> {
      if (topology.kind === "pipeline") return runPipeline(input);
      if (topology.kind === "supervisor") return runSupervisor(input);
      throw new Error(`Unknown topology kind: ${topology.kind}`);
    },
  };
}
