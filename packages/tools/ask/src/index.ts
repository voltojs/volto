/**
 * @volto/tools-ask — ask_user tool
 *
 * Uses ApprovalGate / EventSink to ask the host a question.
 * When the host lacks interactive capability, returns isError.
 */

import type { ApprovalGate, EventSink, Id } from "@volto/core";
import { z } from "zod";
import { defineTool } from "@volto/tools-common";
import type { Tool } from "@volto/tools-common";

const schema = z.object({
  question: z.string().describe("The question to ask the user."),
  options: z
    .array(z.object({ label: z.string(), description: z.string().optional() }))
    .optional()
    .describe("Present these choices to the user (single-select unless multiSelect)."),
  multiSelect: z.boolean().optional().describe("Allow choosing several options."),
});

export interface AskUserOptions {
  /** Approval gate to present the question to the host */
  approvalGate: ApprovalGate;
  /** Event sink for emitting the ask event */
  eventSink: EventSink;
  /**
   * Id source used to give each call a unique gate-facing call id.
   *
   * A hardcoded id would let a second concurrent ask_user call overwrite
   * the first's pending entry in any gate keyed by call id (e.g.
   * `pending.set(call.id, ...)`), silently orphaning the first call's
   * promise forever. Optional so existing callers that construct this tool
   * directly (mainly tests) keep working — when omitted, a monotonic
   * counter local to this tool instance is used instead, which is still
   * unique per call within that instance.
   */
  id?: Id;
}

/**
 * Create an ask_user tool that prompts the host for input.
 *
 * The tool emits an "ask_user" event (question, options, multiSelect and a
 * gate-facing callId) via EventSink and waits for the ApprovalGate response:
 * - "allow" → the user answered; an `ApprovalResult.answer` array carries the
 *   selected labels and/or free text, joined into the tool result. A bare
 *   allow (no answer) falls back to "yes".
 * - "deny"  → the user skipped; reported as plain text, not an error, so the
 *   model can continue with what it already knows.
 */
export function createAskUserTool(opts: AskUserOptions): Tool {
  // Fallback uniqueness source when no Id port is injected — still
  // monotonic (and thus unique) per call within this tool instance.
  let localCounter = 0;
  return defineTool({
    name: "ask_user",
    description: "Ask the user a question and return their response. Use this when you need clarification or human input.",
    schema,
    requires: [],
    riskTier: "READ_ONLY",
    run: async (input) => {
      const { question, options, multiSelect } = input;
      // Unique gate-facing call id, generated before the emit so the host UI
      // can correlate the ask_user event with the pending gate call.
      const callId = opts.id ? `ask_user-${opts.id.next()}` : `ask_user-${++localCounter}`;
      // Emit an event so the host UI can display the question with its choices
      opts.eventSink.emit({
        type: "ask_user",
        data: { callId, question, options, multiSelect },
      });

      try {
        // Use ApprovalGate to present the question. A gate may answer with a
        // bare decision or with an ApprovalResult (reason / answer attached).
        // Normalize before comparing — `object === "allow"` is always false,
        // which would silently report every confirmation as a decline.
        const raw = await opts.approvalGate.ask(
          { id: callId, name: "ask_user", input: { question } },
          "READ_ONLY",
        );
        const decision = typeof raw === "string" ? raw : raw.decision;
        const answer = typeof raw === "string" ? undefined : raw.answer;

        if (decision === "allow") {
          const joined = (answer ?? []).join("; ") || "yes";
          return {
            modelContent: `User answer: ${joined}`,
            displayMetadata: { question, answer },
          };
        }
        return {
          modelContent: "The user did not answer this question. Continue with what you have, or ask again later.",
          displayMetadata: { question, answered: false },
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
