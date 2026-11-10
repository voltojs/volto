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
  /**
   * The session's directory once the command finished. Absent when the shell
   * never reported one (timeout rebuild, or the shell died first) — the tool
   * then says nothing about the cwd rather than guessing.
   */
  cwdAfter?: string;
  /**
   * True only when the command moved the session from a previously REPORTED
   * directory. The session owns this comparison: the spawn cwd and the shell's
   * `$PWD` may spell one directory two ways, and comparing them here would
   * report a move on every first command.
   */
  cwdChanged?: boolean;
}

export interface BashSessionLike {
  run(
    cmd: string,
    opts?: { cwd?: string; timeout?: number },
  ): Promise<BashSessionRunResult>;
  /**
   * The directory the session is in right now. Optional: a session that
   * cannot report it simply never triggers the cwd confirmation note.
   */
  cwd?: () => string | undefined;
}
