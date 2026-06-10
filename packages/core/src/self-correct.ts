/**
 * Self-correction loop — pure function for validation-repair decisions.
 *
 * When a tool result or model output fails validation, this module
 * generates a structured repair prompt to guide the model toward fixing
 * the issue. The validation judgment is pure; actually running the
 * validation (tests, lint, schema check) happens via tools/Sandbox.
 *
 * Self-correction count is tracked in serializable state and has a hard
 * upper limit to prevent runaway loops.
 */

// ──────────────────────────────────────────────
// Types
// ──────────────────────────────────────────────

/** Result of a validation check */
export interface ValidationResult {
  /** Whether validation passed */
  passed: boolean;
  /** Summary of what failed */
  failures: string[];
  /** The validator name (e.g., "schema", "test", "lint") */
  validatorName: string;
}

/** Decision returned by the self-correct pure function */
export interface SelfCorrectDecision {
  /** Whether to trigger a self-correction loop */
  shouldCorrect: boolean;
  /** Structured repair prompt to feed back to the model */
  repairPrompt?: string;
  /** Number of corrections remaining before forced termination */
  remainingBudget: number;
}

export const DEFAULT_MAX_SELF_CORRECTIONS = 3;

// ──────────────────────────────────────────────
// Pure decision function
// ──────────────────────────────────────────────

/**
 * Decide whether to trigger self-correction based on a validation failure
 * and the current self-correction budget.
 *
 * Pure function — zero I/O, deterministic.
 *
 * @param validation - the validation result to evaluate
 * @param currentCount - how many self-corrections have already been attempted
 * @param maxCorrections - maximum allowed (default 3)
 */
export function decideSelfCorrect(
  validation: ValidationResult,
  currentCount: number,
  maxCorrections: number = DEFAULT_MAX_SELF_CORRECTIONS,
): SelfCorrectDecision {
  // If validation passed, no correction needed
  if (validation.passed) {
    return {
      shouldCorrect: false,
      remainingBudget: maxCorrections - currentCount,
    };
  }

  // Budget exhausted → forced termination
  if (currentCount >= maxCorrections) {
    return {
      shouldCorrect: false,
      remainingBudget: 0,
      repairPrompt: `[SELF-CORRECT BUDGET EXHAUSTED] ${validation.validatorName} validation failed ${maxCorrections} times. Failures:\n${validation.failures.map((f) => `- ${f}`).join("\n")}`,
    };
  }

  // Budget remaining → generate repair prompt
  const remaining = maxCorrections - currentCount - 1;
  return {
    shouldCorrect: true,
    remainingBudget: remaining,
    repairPrompt: [
      `[SELF-CORRECT — ${validation.validatorName} validation failed]`,
      `The following issues were found:`,
      ...validation.failures.map((f) => `- ${f}`),
      ``,
      `Please fix these issues and try again. (${remaining} correction${remaining === 1 ? "" : "s"} remaining)`,
    ].join("\n"),
  };
}

// ──────────────────────────────────────────────
// Validation runner (declarative, not I/O)
// ──────────────────────────────────────────────

/**
 * A declarative validator that can be registered for tool results.
 * The actual validation logic (running tests, lint, etc.) is done via
 * the tool system; this module only provides the decision structure.
 */
export interface Validator {
  name: string;
  /** Validate a tool result and return a ValidationResult */
  validate(toolName: string, resultContent: string): ValidationResult;
}

/**
 * Schema-based validator: checks if content is valid JSON and
 * optionally matches expected structure.
 */
export function createSchemaValidator(expectedKeys?: string[]): Validator {
  return {
    name: "schema",
    validate(toolName: string, resultContent: string): ValidationResult {
      try {
        const parsed = JSON.parse(resultContent);

        if (expectedKeys) {
          const missing = expectedKeys.filter((k) => !(k in parsed));
          if (missing.length > 0) {
            return {
              passed: false,
              failures: [`Missing required keys: ${missing.join(", ")}`],
              validatorName: "schema",
            };
          }
        }

        return { passed: true, failures: [], validatorName: "schema" };
      } catch {
        return {
          passed: false,
          failures: [`Invalid JSON: ${resultContent.slice(0, 100)}...`],
          validatorName: "schema",
        };
      }
    },
  };
}
