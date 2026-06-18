/**
 * @volto/tools-ask — ask_user tool
 *
 * Uses ApprovalGate / EventSink to ask the host a question.
 * When the host lacks interactive capability, returns isError.
 */

import type { ApprovalGate, EventSink } from "@volto/core";
import { z } from "zod";
import { defineTool } from "@volto/tools-common";
import type { Tool } from "@volto/tools-common";

const schema = z.object({
  question: z.string().describe("The question to ask the user."),
});

export interface AskUserOptions {
  /** Approval gate to present the question to the host */
  approvalGate: ApprovalGate;
  /** Event sink for emitting the ask event */
  eventSink: EventSink;
}

/**
 * Create an ask_user tool that prompts the host for input.
 *
 * The tool emits an "ask_user" event via EventSink and waits for
 * the ApprovalGate response. Since ApprovalGate is designed for
 * tool-call approval (allow/deny), we use a thin wrapper:
 * - The question is emitted as an event so the host UI can display it
 * - The ApprovalGate.ask() result maps "allow" → user answered "yes"
 *   and "deny" → user answered "no"
 *
 * For a real interactive implementation, hosts should override this
 * with their own ApprovalGate that supports free-text responses.
 */
export function createAskUserTool(opts: AskUserOptions): Tool {
  return defineTool({
    name: "ask_user",
    description: "Ask the user a question and return their response. Use this when you need clarification or human input.",
    schema,
    requires: [],
    riskTier: "READ_ONLY",
    run: async ({ question }) => {
      // Emit an event so the host UI can display the question
      opts.eventSink.emit({
        type: "ask_user",
        data: { question },
      });

      try {
        // Use ApprovalGate to present the question.
        // The gate returns "allow" or "deny" — we interpret allow as "user confirmed"
        // and deny as "user declined". For a real interactive host, the gate
        // implementation should be overridden to support free-text input.
        const decision = await opts.approvalGate.ask(
          { id: "ask_user", name: "ask_user", input: { question } },
          "READ_ONLY",
        );

        if (decision === "allow") {
          return {
            modelContent: `User confirmed: yes`,
            displayMetadata: { question, answer: "yes" },
          };
        }
        return {
          modelContent: `User declined: no`,
          displayMetadata: { question, answer: "no" },
        };
      } catch {
        return {
          modelContent: `ask_user: host is not available or does not support user interaction.`,
          isError: true,
          displayMetadata: { question },
        };
      }
    },
  });
}

export const CAP_ASK_USER: string[] = [];
