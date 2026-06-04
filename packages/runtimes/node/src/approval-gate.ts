/**
 * ApprovalGate implementations for HITL approval.
 *
 * - auto-allow: all approvals automatically granted (for testing / non-interactive)
 * - interactive: terminal-based y/n prompt
 */

import type { ApprovalGate, PendingToolCall, RiskTier } from "@agent-core/core";
import * as readline from "node:readline";

/**
 * Auto-allow gate — all approvals are automatically granted.
 * Useful for testing, CI, or non-interactive environments.
 */
export function createAutoAllowGate(): ApprovalGate {
  return {
    ask: async () => "allow",
  };
}

/**
 * Interactive gate — prompts the user in the terminal.
 * Displays tool name, risk tier, and input, then waits for y/n.
 */
export function createInteractiveGate(): ApprovalGate {
  return {
    ask: async (call: PendingToolCall, riskTier: RiskTier): Promise<"allow" | "deny"> => {
      const rl = readline.createInterface({
        input: process.stdin,
        output: process.stderr,
      });

      return new Promise<"allow" | "deny">((resolve) => {
        let resolved = false;
        const inputStr = JSON.stringify(call.input, null, 2);
        process.stderr.write(
          `\n--- Approval Required ---\n` +
          `Tool: ${call.name}\n` +
          `Risk: ${riskTier}\n` +
          `Input: ${inputStr}\n` +
          `Allow? (y/n) `,
        );

        rl.on("line", (line) => {
          if (resolved) return;
          resolved = true;
          rl.close();
          const answer = line.trim().toLowerCase();
          resolve(answer === "y" || answer === "yes" ? "allow" : "deny");
        });

        rl.on("close", () => {
          if (resolved) return;
          resolved = true;
          resolve("deny");
        });
      });
    },
  };
}
