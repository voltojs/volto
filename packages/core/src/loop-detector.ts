/**
 * Loop detector — pure function for detecting oscillation/repeated tool failures.
 *
 * Scans recent message history for K consecutive (assistant_tool_use → tool_result_error)
 * pairs with identical tool name + input. This catches infinite loops where the
 * model repeatedly calls the same tool with the same arguments and gets errors.
 *
 * Zero I/O, zero side effects, fully deterministic and replayable.
 */

import type { Message, AssistantMessage, ToolResultMessage, PendingToolCall } from "./state.js";

export interface LoopDetectionResult {
  detected: boolean;
  /** The tool call name that is looping, if detected */
  toolName?: string;
  /** The input that is looping, if detected */
  toolInput?: Record<string, unknown>;
  /** Number of consecutive identical failed calls found */
  consecutiveCount: number;
}

/**
 * Detect if the last K-1 tool call/result pairs (before the new pending calls)
 * form a loop with any of the new pending tools.
 *
 * @param priorMessages - message history BEFORE the current assistant message
 * @param currentAssistantMsg - the assistant message just produced (with the new tool calls)
 * @param newToolCalls - the tool calls extracted from currentAssistantMsg
 * @param k - the loop threshold: detect when K or more consecutive identical failures occur
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

  // For each new pending tool call, check if it matches a loop in the trace
  for (const newCall of newToolCalls) {
    let consecutiveCount = 1; // Count the new call itself

    for (const entry of trace) {
      if (
        entry.name === newCall.name &&
        entry.isError &&
        deepEqual(entry.input, newCall.input)
      ) {
        consecutiveCount++;
      } else {
        break; // Loop broken — consecutive chain ends
      }
    }

    if (consecutiveCount >= k) {
      return {
        detected: true,
        toolName: newCall.name,
        toolInput: newCall.input,
        consecutiveCount,
      };
    }
  }

  return { detected: false, consecutiveCount: 0 };
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
