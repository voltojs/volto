/**
 * Minimal session contract consumed by the bash tool.
 *
 * Declared here so `@volto/tools-shell` never value-imports (or even
 * type-imports) `@volto/runtime-node`. `PersistentSession` in runtime-node
 * structurally satisfies this interface.
 */
export interface BashSessionRunResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  /**
   * Non-empty when the underlying session had to be killed and rebuilt
   * (e.g. stuck-command timeout). The tool layer MUST surface this to the
   * model so it knows cd/export/source state was reset.
   */
  stateResetReason?: string;
  /**
   * True when the session's own timeout mechanism terminated the command.
   * The bash tool classifies such results as errors carrying the unified
   * timeout signature (spec D3 of the timeout-policy design). Optional so
   * sessions without a determinable timeout path keep the old behavior.
   */
  timedOut?: boolean;
}

export interface BashSessionLike {
  run(
    cmd: string,
    opts?: { cwd?: string; timeout?: number },
  ): Promise<BashSessionRunResult>;
}
