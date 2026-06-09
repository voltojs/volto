/**
 * retrieval.ts — Pure function for RAG slot placement.
 *
 * Given retrieval fragments, determines the injection position:
 * - After static prefix cache breakpoints (so prefix stays cacheable)
 * - Before variable content (conversation messages)
 *
 * This is a pure data transformation — no I/O.
 */

/**
 * Determine where RAG retrieval fragments should be injected
 * in the assembled message array.
 *
 * @param cacheBreakpoints - Cache breakpoints from ContextAssembler
 * @param totalMessages - Total number of messages in the assembled array
 * @returns The index at which RAG fragments should be inserted
 */
export function computeRAGInjectionIndex(
  cacheBreakpoints: number[],
  totalMessages: number,
): number {
  // RAG content goes after the last cache breakpoint (static prefix boundary)
  // but before variable content. If no breakpoints, inject at the end of
  // the prefix (typically after system messages).
  if (cacheBreakpoints.length === 0) {
    // Fallback: inject at the beginning (after any system messages)
    return 0;
  }

  // The last breakpoint marks the end of the static prefix
  const lastBreakpoint = cacheBreakpoints[cacheBreakpoints.length - 1] ?? 0;

  // Inject right after the last breakpoint, clamped to message count
  return Math.min(lastBreakpoint + 1, totalMessages);
}

/**
 * Build a synthetic user message containing RAG retrieval fragments.
 * This message is inserted at the computed injection index.
 *
 * @param fragments - Retrieved text fragments
 * @returns A synthetic message with the fragments
 */
export function buildRAGMessage(fragments: string[]): string {
  if (fragments.length === 0) return "";

  const blocks = fragments
    .map((f, i) => `[${i + 1}] ${f}`)
    .join("\n\n");

  return `# Retrieved Context\n\n${blocks}`;
}
