/**
 * Loop detector — pure function for detecting oscillation/repeated tool calls.
 *
 * Scans recent message history for K consecutive (assistant_tool_use → tool_result)
 * pairs with identical tool name + input, and classifies the loop by outcome:
 * - "error-loop": K consecutive identical FAILED calls (isError = true).
 * - "repeat": K consecutive identical NON-error calls (repeated successes).
 *
 * Two independent chains are counted from the same trace: the error chain counts
 * trailing error-matches, the repeat chain counts trailing non-error-matches.
 * Mixed sequences (successes then failures or vice versa) never merge — each
 * chain breaks at the first entry whose outcome does not match it.
 *
 * Zero I/O, zero side effects, fully deterministic and replayable.
 */

import type { Message, AssistantMessage, ToolResultMessage, PendingToolCall } from "./state.js";

export interface LoopDetectionResult {
  detected: boolean;
  /** Classification when detected: repeated failures vs. repeated successes (spec §4.1) */
  kind?: "error-loop" | "repeat";
  /** The tool call name that is looping, if detected */
  toolName?: string;
  /** The input that is looping, if detected */
  toolInput?: Record<string, unknown>;
  /** Number of consecutive identical calls found (includes the new pending call) */
  consecutiveCount: number;
}

/**
 * Detect if the last K-1 tool call/result pairs (before the new pending calls)
 * form a loop with any of the new pending tools.
 *
 * The error chain is checked first across all new calls: if any new call's
 * error chain reaches K, an "error-loop" result is returned (error is the more
 * severe kind and takes precedence over repeat).
 *
 * @param priorMessages - message history BEFORE the current assistant message
 * @param currentAssistantMsg - the assistant message just produced (with the new tool calls)
 * @param newToolCalls - the tool calls extracted from currentAssistantMsg
 * @param k - the loop threshold: detect when K or more consecutive identical calls occur
 * @returns detection result
 */
export function detectLoop(
  priorMessages: Message[],
  currentAssistantMsg: AssistantMessage,
  newToolCalls: PendingToolCall[],
  k: number,
): LoopDetectionResult {
  if (k < 2 || newToolCalls.length === 0) {
    return { detected: false, consecutiveCount: 0 };
  }

  // Build a compact trace of recent tool interactions (name, input, isError)
  // by scanning prior messages backwards in pairs: tool_result ← assistant(tool_use).
  // We do NOT include currentAssistantMsg in the scan — it contains the NEW calls.
  const trace: Array<{ name: string; input: Record<string, unknown>; isError: boolean }> = [];

  let i = priorMessages.length - 1;
  while (i >= 0 && trace.length < k) {
    const msg = priorMessages[i]!;

    if (msg.role === "tool") {
      const toolResult = msg as ToolResultMessage;
      const isError = toolResult.content.some((c) => c.isError === true);
      const toolUseId = toolResult.content[0]?.toolUseId;

      // Walk backwards to find the matching assistant message with tool_use
      let j = i - 1;
      while (j >= 0) {
        const prevMsg = priorMessages[j]!;
        if (prevMsg.role === "assistant") {
          const assistantMsg = prevMsg as AssistantMessage;
          const toolUseBlock = assistantMsg.content.find(
            (c) => c.type === "tool_use" && c.id === toolUseId,
          );
          if (toolUseBlock && toolUseBlock.type === "tool_use") {
            trace.push({
              name: toolUseBlock.name,
              input: toolUseBlock.input,
              isError,
            });
            break;
          }
        }
        j--;
      }
    }
    i--;
  }

  // Error chain pass (original semantics): consecutive trailing matches with
  // name + input + isError = true. Returns on the first hit (severity precedence).
  for (const newCall of newToolCalls) {
    const consecutiveCount = countChain(trace, newCall, true);
    if (consecutiveCount >= k) {
      return {
        detected: true,
        kind: "error-loop",
        toolName: newCall.name,
        toolInput: newCall.input,
        consecutiveCount,
      };
    }
  }

  // Repeat chain pass: consecutive trailing matches with name + input where
  // every traced outcome is NON-error. Never merges with the error chain.
  for (const newCall of newToolCalls) {
    const consecutiveCount = countChain(trace, newCall, false);
    if (consecutiveCount >= k) {
      return {
        detected: true,
        kind: "repeat",
        toolName: newCall.name,
        toolInput: newCall.input,
        consecutiveCount,
      };
    }
  }

  return { detected: false, consecutiveCount: 0 };
}

/**
 * Count the consecutive matching chain for one new pending call.
 * Starts at 1 (the new call itself) and walks the trace (most recent first);
 * the chain breaks at the first entry that does not match name + input + outcome.
 */
function countChain(
  trace: Array<{ name: string; input: Record<string, unknown>; isError: boolean }>,
  newCall: PendingToolCall,
  requireError: boolean,
): number {
  let consecutiveCount = 1; // Count the new call itself

  for (const entry of trace) {
    const outcomeMatches = requireError ? entry.isError : !entry.isError;
    if (
      entry.name === newCall.name &&
      outcomeMatches &&
      deepEqual(entry.input, newCall.input)
    ) {
      consecutiveCount++;
    } else {
      break; // Loop broken — consecutive chain ends
    }
  }

  return consecutiveCount;
}

/**
 * Render the soft-tier loop reminder text (spec §2 D3, verbatim format).
 * Both variants share the LOOP REMINDER marker; consumed before the K threshold
 * (error) and for repeated identical successes (repeat).
 */
export function renderLoopReminder(t: {
  toolName: string;
  consecutiveCount: number;
  kind: "error" | "repeat";
}): string {
  if (t.kind === "error") {
    return `[LOOP REMINDER] "${t.toolName}" has been called ${t.consecutiveCount} times in a row with identical input and each attempt failed. This is the last reminder before a forced stop — change the approach now.`;
  }
  return `[LOOP REMINDER] "${t.toolName}" has been called ${t.consecutiveCount} times in a row with identical input. If the repetition is intentional, continue; otherwise vary the input or switch tools.`;
}

/**
 * Render the intervention-tier loop text (spec §2 D3, verbatim format).
 * The closing "Two more" sentence is fixed wording (default budget of 2),
 * intentionally not coupled to the configured intervention budget.
 */
export function renderLoopIntervention(t: { toolName: string; consecutiveCount: number }): string {
  return `[LOOP INTERVENTION] The identical call to "${t.toolName}" has failed ${t.consecutiveCount} times. Do not repeat it: vary the input, choose a different tool, or ask the user for direction. Two more identical failures will force-stop this turn.`;
}

/** Simple deep equality for plain objects (no cycles, no special types) */
function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a === null || b === null || typeof a !== "object" || typeof b !== "object") return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;

  const keysA = Object.keys(a as Record<string, unknown>);
  const keysB = Object.keys(b as Record<string, unknown>);
  if (keysA.length !== keysB.length) return false;

  for (const key of keysA) {
    if (!Object.prototype.hasOwnProperty.call(b, key)) return false;
    if (!deepEqual((a as Record<string, unknown>)[key], (b as Record<string, unknown>)[key])) return false;
  }

  return true;
}
