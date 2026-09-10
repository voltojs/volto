/**
 * Execution-time facts about a sandbox backend.
 *
 * Separate from SandboxConfig on purpose: the config says what was ASKED
 * for, this says what the selected backend actually achieves and how its
 * failures look. The distinction is what makes "the sandbox never ran" a
 * detectable state rather than a silent one.
 */

/** Backends that actually confine. `none` is not one of them. */
export type SandboxBackendName = "seatbelt" | "bubblewrap";

/**
 * How completely the selected backend enforces the policy's file effects.
 * `partial` means the active backend cannot govern every promised effect;
 * a caller requiring an absolute boundary must not treat it as `full`.
 */
export type SandboxEnforcement = "full" | "partial" | "none";

/**
 * Evidence that the runner failed BEFORE executing the wrapped command.
 * A consumer applies `allowedExitCodes` when present, removes
 * `informationalLines` by case-insensitive exact line equality, then matches
 * `fatalSignatures` case-insensitively within each remaining stderr line.
 * Exit status alone never proves runner failure.
 */
export interface RunnerFailureRule {
  /** Nonzero exit codes this rule may match; omitted permits any nonzero exit. */
  allowedExitCodes?: readonly number[];
  /** Substrings identifying a fatal runner diagnostic on one stderr line. */
  fatalSignatures: readonly string[];
  /** Benign runner lines excluded by exact full-line equality before matching. */
  informationalLines?: readonly string[];
}

/**
 * Each backend's DENIAL dialect: the stderr substrings a file effect denied
 * by THIS backend produces. Matched case-insensitively.
 *
 * Deliberately per-backend rather than a union — the union claims denials a
 * given backend never produces, which turns "the sandbox is broken" into
 * "the sandbox worked" on the wrong platform.
 */
export const DENIAL_SIGNATURES: Record<SandboxBackendName, readonly string[]> = {
  // Seatbelt denies with EPERM.
  seatbelt: ["operation not permitted"],
  // bwrap's read-only binds surface as EROFS; Landlock paths give EACCES.
  bubblewrap: ["read-only file system", "permission denied"],
};

/**
 * Each backend's RUNNER-FAILURE evidence — the runner refusing or crashing
 * before the wrapped command ever ran.
 */
export const RUNNER_FAILURE_RULES: Record<SandboxBackendName, readonly RunnerFailureRule[]> = {
  seatbelt: [
    {
      fatalSignatures: [
        // The exact defect this file exists to make impossible: passing a
        // path to `-p`, which takes a profile STRING, made sandbox-exec
        // fail here every single time while the suite stayed green.
        "unbound variable",
        "sandbox-exec: cannot read",
        "failed to parse profile",
        "profile evaluation failed",
      ],
    },
  ],
  bubblewrap: [
    {
      fatalSignatures: [
        "can't create file",
        "no permissions to creating user namespace",
        "bwrap: execvp",
        "setting up uid map",
      ],
      // bwrap narrates namespace setup on stderr during healthy runs.
      informationalLines: ["bwrap: Creating new namespace"],
    },
  ],
};

/**
 * Decide whether this run's stderr proves the RUNNER failed rather than the
 * command. Returns the matching stderr line, or null.
 *
 * Runner failure means the command never ran — sandbox infrastructure is
 * broken. Denial means confinement worked and blocked it. Consumers must
 * check this FIRST: reporting broken infrastructure as an ordinary command
 * failure is exactly how the sandbox stayed dead for three review rounds.
 */
export function classifyRunnerFailure(
  backend: SandboxBackendName,
  exitCode: number | undefined,
  stderr: string,
): string | null {
  // Exit status alone never proves runner failure, and a success cannot be one.
  if (exitCode === undefined || exitCode === 0) return null;

  const rules = RUNNER_FAILURE_RULES[backend];
  const lines = stderr.split("\n").map((l) => l.trim()).filter((l) => l !== "");

  for (const rule of rules) {
    if (rule.allowedExitCodes && !rule.allowedExitCodes.includes(exitCode)) continue;

    const informational = new Set(
      (rule.informationalLines ?? []).map((l) => l.toLowerCase()),
    );
    for (const line of lines) {
      if (informational.has(line.toLowerCase())) continue;
      const lower = line.toLowerCase();
      for (const signature of rule.fatalSignatures) {
        if (lower.includes(signature.toLowerCase())) return line;
      }
    }
  }
  return null;
}
