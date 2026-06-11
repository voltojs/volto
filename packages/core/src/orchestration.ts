/**
 * Orchestration topology spec types — pure data, no I/O.
 * Defines the shapes for supervisor and pipeline multi-agent topologies.
 */

/** Node in a topology graph */
export interface TopologyNodeSpec {
  /** Unique node name */
  name: string;
  /** System prompt for this node's agent */
  systemPrompt: string;
  /** Model override (optional — falls back to topology default) */
  model?: string;
  /** Tools available to this node's agent (by name from registry) */
  tools?: string[];
  /** Capabilities required for this node */
  capabilities?: string[];
}

/** Topology kind */
export type TopologyKind = "pipeline" | "supervisor";

/**
 * Topology specification — declarative data that describes a multi-agent
 * collaboration structure. Pure data, no execution logic.
 */
export interface TopologySpec {
  /** Topology kind */
  kind: TopologyKind;
  /** Human-readable name */
  name: string;
  /** Default model for all nodes (can be overridden per-node) */
  model?: string;
  /** Nodes in this topology */
  nodes: TopologyNodeSpec[];
  /**
   * Pipeline: ordered list of node names (sequential chain).
   * Supervisor: list of worker node names (the first node is the supervisor).
   */
  order: string[];
}

/**
 * Result of running a topology — the final aggregated output.
 */
export interface TopologyResult {
  /** Final output text from the topology */
  output: string;
  /** Per-node results: node name → output text */
  nodeOutputs: Record<string, string>;
}
