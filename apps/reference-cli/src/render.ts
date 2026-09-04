/**
 * Reference renderer — derives stdout/stderr writes from agent events.
 *
 * Kept side-effect free (writes flow through caller-supplied callbacks) so the
 * CLI's rendering behavior can be unit-tested without touching real stdio.
 *
 * Sub-agent events carry `agentDepth` / `agentLabel` (injected by the SDK's
 * `tagEventSink`). The renderer bracket-wraps and prefixes them so the host
 * output doesn't intermix opaquely with the main agent's stream.
 */

import type { EventSink } from "@volto/core";

export interface RenderTargets {
  /** Called with text destined for stdout (main visible output). */
  stdout: (s: string) => void;
  /** Called with text destined for stderr (status / framing). Optional. */
  stderr?: (s: string) => void;
}

export function createRenderingEventSink(targets: RenderTargets): EventSink {
  let activeDepth = 0;
  let inSubBlock = false;

  function openSubIfNeeded(depth: number, label: string | undefined): void {
    if (depth > 0 && !inSubBlock) {
      const tag = label ? `${label} (depth=${depth})` : `sub-agent (depth=${depth})`;
      targets.stdout(`\n[${tag}]\n`);
      inSubBlock = true;
      activeDepth = depth;
    }
  }

  function closeSubIfNeeded(): void {
    if (inSubBlock) {
      targets.stdout(`\n[/${activeDepth > 0 ? `depth=${activeDepth}` : "sub"}]\n`);
      inSubBlock = false;
      activeDepth = 0;
    }
  }

  return {
    emit(event) {
      const depth = typeof event.data["agentDepth"] === "number"
        ? (event.data["agentDepth"] as number)
        : 0;
      const label = typeof event.data["agentLabel"] === "string"
        ? (event.data["agentLabel"] as string)
        : undefined;

      if (event.type === "text_delta") {
        openSubIfNeeded(depth, label);
        if (depth === 0 && inSubBlock) closeSubIfNeeded();
        targets.stdout(event.data["text"] as string);
        return;
      }
      if (event.type === "assistant_message") {
        // One per model call (the runner no longer emits raw model_done —
        // task-r6; the transcript assistant_message closes each call's text).
        // End-of-turn newline. Close any open sub block first so framing
        // brackets land before the trailing newline.
        if (depth === 0 && inSubBlock) closeSubIfNeeded();
        targets.stdout("\n");
        return;
      }
    },
  };
}
