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
}

export interface BashSessionLike {
  run(
    cmd: string,
    opts?: { cwd?: string; timeout?: number },
  ): Promise<BashSessionRunResult>;
}
