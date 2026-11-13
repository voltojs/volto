/** Capability required by the task tool to create sub-agents */
export const CAP_AGENT_TASK = "agent:task";

/**
 * Delegation budget: granted while the agent is still below maxAgentDepth.
 * Mirrors @voltojs/core's CAP_AGENT_DEPTH_AVAILABLE — tools packages may only
 * type-import core, so the string is declared here.
 */
export const CAP_AGENT_DEPTH_AVAILABLE = "agent:can-delegate";
