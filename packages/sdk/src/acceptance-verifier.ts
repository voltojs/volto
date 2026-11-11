/**
 * Acceptance verifier — one structured model call per dispatch attempt.
 *
 * The deterministic parts (prompt, schema, limits, rework decisions) live in
 * @volto/core; this module owns the I/O: a single tools-free model call whose
 * JSON answer becomes an AcceptanceVerdict. Anything unverifiable (timeout,
 * port error, unparseable output) maps to an `error` verdict — never `failed`.
 */

import { z } from "zod";
import type { AcceptanceVerdict, ModelPort, ModelRequest, TokenUsage } from "@volto/core";
import { ACCEPTANCE_LIMITS, ACCEPTANCE_VERDICT_SCHEMA, renderAcceptancePrompt } from "@volto/core";

/** Default wall-clock budget for one verifier call (Task 6 re-exports it). */
export const ACCEPTANCE_VERIFY_TIMEOUT_MS = 60_000;

// ──────────────────────────────────────────────
// Verifier call
// ──────────────────────────────────────────────

export interface VerifyDispatchInput {
  modelPort: ModelPort;
  model?: string;
  acceptance: string;
  task: string;
  output: string;
  evidence: string;
  timeoutMs?: number;
}

export interface VerifyDispatchResult {
  verdict: AcceptanceVerdict;
  usage?: TokenUsage;
}

/**
 * Run one verifier model call and map its answer to an AcceptanceVerdict.
 *
 * The stream consumption is raced against a timeout: a port that never yields
 * (and ignores abort) must not hang the dispatch loop. On timeout we abort,
 * swallow the abandoned consumption, and return an `error` verdict.
 */
export async function verifyDispatch(input: VerifyDispatchInput): Promise<VerifyDispatchResult> {
  const timeoutMs = input.timeoutMs ?? ACCEPTANCE_VERIFY_TIMEOUT_MS;
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;

  const consume = async (): Promise<VerifyDispatchResult> => {
    const request: ModelRequest = {
      messages: [
        {
          id: "acceptance-verifier",
          role: "user",
          content: renderAcceptancePrompt({
            task: input.task,
            acceptance: input.acceptance,
            output: input.output,
            evidence: input.evidence,
          }),
        },
      ],
      tools: [],
      model: input.model,
      temperature: 0,
      maxTokens: 800,
      responseFormat: { type: "json", schema: ACCEPTANCE_VERDICT_SCHEMA },
      abortSignal: controller.signal,
    };

    let text = "";
    let usage: TokenUsage | undefined;
    for await (const event of input.modelPort.stream(request)) {
      if (event.type === "text_delta") {
        text += event.text;
      } else if (event.type === "usage") {
        const { type: _type, ...tokens } = event;
        usage = tokens;
      } else if (event.type === "error") {
        return { verdict: errorVerdict(event.error) };
      } else if (event.type === "done") {
        break;
      }
    }
    return { verdict: parseAcceptanceVerdict(text), ...(usage !== undefined ? { usage } : {}) };
  };

  // Resolves (never rejects) with a sentinel when the budget runs out.
  const timeout = new Promise<undefined>((resolve) => {
    timer = setTimeout(() => resolve(undefined), timeoutMs);
  });

  const consumed = consume();
  try {
    const raced = await Promise.race([consumed, timeout]);
    if (raced === undefined) {
      controller.abort();
      // The abandoned stream may still reject later; keep it handled.
      consumed.catch(() => {});
      return { verdict: errorVerdict(`acceptance verification timed out after ${timeoutMs}ms`) };
    }
    return raced;
  } catch (err) {
    controller.abort();
    return { verdict: errorVerdict(err instanceof Error ? err.message : String(err)) };
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

// ──────────────────────────────────────────────
// Verdict parsing
// ──────────────────────────────────────────────

const verdictSchema = z.object({
  passed: z.boolean(),
  failures: z.array(z.string()),
  retry_hint: z.string().optional(),
});

function errorVerdict(message: string): AcceptanceVerdict {
  return {
    status: "error",
    failures: [],
    verifierError: message.slice(0, ACCEPTANCE_LIMITS.maxVerifierErrorChars),
  };
}

/**
 * Extract the first complete JSON object with a string-aware brace scan:
 * braces inside string literals (and escaped quotes) do not affect depth.
 */
function extractFirstJsonObject(raw: string): string | undefined {
  let start = -1;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = 0; i < raw.length; i++) {
    const ch = raw.charAt(i);
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') {
      inString = true;
    } else if (ch === "{") {
      if (depth === 0) start = i;
      depth++;
    } else if (ch === "}" && depth > 0) {
      depth--;
      if (depth === 0 && start >= 0) return raw.slice(start, i + 1);
    }
  }
  return undefined;
}

/** Parse a verifier answer leniently; invalid output becomes an error verdict. */
export function parseAcceptanceVerdict(raw: string): AcceptanceVerdict {
  const candidate = extractFirstJsonObject(raw);
  if (candidate === undefined) {
    return errorVerdict("verifier output contains no JSON object");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(candidate);
  } catch (err) {
    return errorVerdict(`verifier output is not valid JSON: ${err instanceof Error ? err.message : String(err)}`);
  }
  const result = verdictSchema.safeParse(parsed);
  if (!result.success) {
    return errorVerdict(`verifier JSON does not match the verdict schema: ${result.error.message}`);
  }
  const verdict = result.data;
  if (verdict.passed) return { status: "passed", failures: [] };
  const out: AcceptanceVerdict = {
    status: "failed",
    failures: verdict.failures
      .slice(0, ACCEPTANCE_LIMITS.maxFailures)
      .map((failure) => failure.slice(0, ACCEPTANCE_LIMITS.maxFailureChars)),
  };
  if (verdict.retry_hint !== undefined) {
    out.retryHint = verdict.retry_hint.slice(0, ACCEPTANCE_LIMITS.maxHintChars);
  }
  return out;
}