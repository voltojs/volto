import { createAgent, type CreateAgentOptions, type AgentInstance } from "@volto/sdk";
import { sse } from "@volto/sdk";

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

export type AgentMode = "local" | "remote";

export interface AgentConfig {
  mode: AgentMode;
  /** URL of the headless server (required for remote mode). */
  serverUrl?: string;
  /** SDK createAgent options (used only in local mode). */
  sdkConfig?: Omit<CreateAgentOptions, "modelPort"> & { modelPort: CreateAgentOptions["modelPort"] };
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Create an Agent instance based on the configured mode.
 *
 * - `local`: embeds the SDK agent directly (all tools run in-browser / Node).
 * - `remote`: returns an SSE client that proxies to a headless server.
 */
export function createWebAgent(
  config: AgentConfig,
): AgentInstance | ReturnType<typeof sse.createSSEClient> {
  if (config.mode === "remote") {
    if (!config.serverUrl) {
      throw new Error("serverUrl is required for remote mode");
    }
    return sse.createSSEClient(config.serverUrl);
  }

  if (!config.sdkConfig) {
    throw new Error("sdkConfig is required for local mode");
  }

  return createAgent(config.sdkConfig);
}
