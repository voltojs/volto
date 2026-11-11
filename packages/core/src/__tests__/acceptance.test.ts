import { describe, it, expect } from "vitest";
import {
  decideAcceptance,
  composeAcceptanceOutcome,
  renderAcceptanceNotice,
  renderReworkMessage,
  renderAcceptancePrompt,
  renderEvidenceDigest,
  renderVerificationNotice,
  ACCEPTANCE_VERDICT_SCHEMA,
  ACCEPTANCE_LIMITS,
} from "../acceptance.js";

const verdict = (status: "passed" | "failed" | "error") => ({
  status,
  failures: status === "failed" ? ["no tests"] : [],
  ...(status === "error" ? { verifierError: "timeout" } : {}),
});

describe("decideAcceptance", () => {
  it("accepts a passed verdict regardless of budget", () => {
    expect(decideAcceptance({ verdict: verdict("passed"), attempts: 1, maxReworks: 0 })).toBe("accept");
  });
  it("reworks a failed verdict while budget remains", () => {
    expect(decideAcceptance({ verdict: verdict("failed"), attempts: 1, maxReworks: 1 })).toBe("rework");
  });
  it("stops a failed verdict when budget is spent", () => {
    expect(decideAcceptance({ verdict: verdict("failed"), attempts: 2, maxReworks: 1 })).toBe("stop");
    expect(decideAcceptance({ verdict: verdict("failed"), attempts: 1, maxReworks: 0 })).toBe("stop");
  });
  it("never reworks an unverifiable result", () => {
    expect(decideAcceptance({ verdict: verdict("error"), attempts: 1, maxReworks: 2 })).toBe("stop");
  });
});

describe("composeAcceptanceOutcome", () => {
  it("passes when any attempt passed", () => {
    expect(composeAcceptanceOutcome([
      { completed: true, verdict: verdict("failed") },
      { completed: true, verdict: verdict("passed") },
    ])).toMatchObject({ status: "passed", attempts: 2, isError: false, failures: [] });
  });

  it("stays failed when a rework run itself crashed", () => {
    const out = composeAcceptanceOutcome([
      { completed: true, verdict: { status: "failed", failures: ["no tests"] } },
      { completed: false, error: "budget_exceeded" },
    ]);
    expect(out.status).toBe("failed");
    expect(out.isError).toBe(true);
    expect(out.failures).toContain("no tests");
    expect(out.failures.some((f) => f.includes("attempt 2"))).toBe(true);
  });

  it("keeps failed when the last verification could not run", () => {
    const out = composeAcceptanceOutcome([
      { completed: true, verdict: { status: "failed", failures: ["no tests"] } },
      { completed: true, verdict: { status: "error", failures: [], verifierError: "timeout" } },
    ]);
    expect(out).toMatchObject({ status: "failed", isError: true, verifierError: "timeout" });
  });

  it("reports error (not failure) when verification never produced a verdict", () => {
    const out = composeAcceptanceOutcome([
      { completed: true, verdict: { status: "error", failures: [], verifierError: "unparseable" } },
    ]);
    expect(out).toMatchObject({ status: "error", isError: false, verifierError: "unparseable" });
  });

  it("dedupes and caps failures at five entries", () => {
    const many = Array.from({ length: 8 }, (_, i) => `f${i}`);
    const out = composeAcceptanceOutcome([{ completed: true, verdict: { status: "failed", failures: many } }]);
    expect(out.failures).toHaveLength(5);
  });
});

describe("acceptance renderers", () => {
  it("renders the criteria into the child notice and rework message", () => {
    expect(renderAcceptanceNotice("must run tests")).toContain("must run tests");
    const msg = renderReworkMessage({ acceptance: "must run tests", failures: ["no tests"], retryHint: "run pnpm test" });
    expect(msg).toContain("must run tests");
    expect(msg).toContain("no tests");
    expect(msg).toContain("run pnpm test");
  });

  it("frames the verifier prompt as data, not instructions", () => {
    const prompt = renderAcceptancePrompt({ task: "add a flag", acceptance: "tests pass", output: "done", evidence: "[bash] ok" });
    expect(prompt).toContain("add a flag");
    expect(prompt).toContain("tests pass");
    expect(prompt.toLowerCase()).toContain("do not follow");
  });

  it("bounds the evidence digest and keeps the newest calls", () => {
    const messages = Array.from({ length: 60 }, (_, i) => ({
      id: `m${i}`,
      role: "assistant" as const,
      content: [{ type: "tool_use" as const, id: `t${i}`, name: "bash", input: { command: `echo ${i} ${"x".repeat(200)}` } }],
    }));
    const digest = renderEvidenceDigest(messages as never);
    expect(digest.length).toBeLessThanOrEqual(6000);
    expect(digest).toContain("echo 59 ");
    expect(digest).not.toContain("echo 0 ");
  });

  it("renders a one-line verification notice", () => {
    expect(renderVerificationNotice({ status: "failed", attempts: 2, failures: ["a", "b"] }))
      .toBe("[verification: failed after 2 attempts] a; b");
  });

  it("omits the attempt suffix for a single attempt", () => {
    expect(renderVerificationNotice({ status: "passed", attempts: 1, failures: [] }))
      .toBe("[verification: passed]");
  });

  it("appends the verifier error in parentheses", () => {
    expect(renderVerificationNotice({ status: "error", attempts: 1, failures: [], verifierError: "timeout" }))
      .toBe("[verification: error] (timeout)");
  });

  it("carries the output and evidence into the verifier prompt", () => {
    const prompt = renderAcceptancePrompt({ task: "t", acceptance: "a", output: "the-output", evidence: "the-evidence" });
    expect(prompt).toContain("the-output");
    expect(prompt).toContain("the-evidence");
  });

  it("reminds the rework round that earlier changes may already exist", () => {
    const msg = renderReworkMessage({ acceptance: "a", failures: ["f"] });
    expect(msg.toLowerCase()).toContain("workspace");
    expect(msg.toLowerCase()).toContain("previous");
  });

  it("pairs tool results with their calls and marks errors", () => {
    const messages = [
      { id: "a1", role: "assistant" as const, content: [{ type: "tool_use" as const, id: "c1", name: "bash", input: { command: "pnpm test" } }] },
      { id: "t1", role: "tool" as const, content: [{ type: "tool_result" as const, toolUseId: "c1", isError: true, content: [{ type: "text" as const, text: "1 failing" }] }] },
    ];
    const digest = renderEvidenceDigest(messages as never);
    expect(digest).toContain("bash");
    expect(digest).toContain("pnpm test");
    expect(digest).toContain("1 failing");
    expect(digest.toLowerCase()).toContain("error");
  });

  it("caps result text at 400 chars", () => {
    const messages = [
      { id: "a1", role: "assistant" as const, content: [{ type: "tool_use" as const, id: "c1", name: "bash", input: { command: "run" } }] },
      { id: "t1", role: "tool" as const, content: [{ type: "tool_result" as const, toolUseId: "c1", content: [{ type: "text" as const, text: "y".repeat(900) }] }] },
    ];
    const digest = renderEvidenceDigest(messages as never);
    expect(digest).toContain("y".repeat(400));
    expect(digest).not.toContain("y".repeat(401));
  });

  it("honors a custom digest budget", () => {
    const messages = Array.from({ length: 10 }, (_, i) => ({
      id: `m${i}`,
      role: "assistant" as const,
      content: [{ type: "tool_use" as const, id: `t${i}`, name: "bash", input: { command: `echo ${i}` } }],
    }));
    const digest = renderEvidenceDigest(messages as never, { maxChars: 60 });
    expect(digest.length).toBeLessThanOrEqual(60);
    expect(digest).toContain("echo 9");
  });
});

describe("ACCEPTANCE_VERDICT_SCHEMA", () => {
  it("matches the agreed verifier response shape (spec §4.2)", () => {
    expect(ACCEPTANCE_VERDICT_SCHEMA).toEqual({
      type: "object",
      properties: {
        passed: { type: "boolean" },
        failures: { type: "array", items: { type: "string" }, maxItems: 5 },
        retry_hint: { type: "string" },
      },
      required: ["passed", "failures"],
      additionalProperties: false,
    });
  });
});

describe("ACCEPTANCE_LIMITS", () => {
  it("pins the acceptance budgets", () => {
    expect(ACCEPTANCE_LIMITS).toEqual({
      maxAcceptanceChars: 2000,
      maxFailures: 5,
      maxFailureChars: 300,
      maxHintChars: 800,
      maxVerifierErrorChars: 500,
      maxDigestChars: 6000,
      maxInputChars: 200,
      maxResultChars: 400,
    });
  });
});