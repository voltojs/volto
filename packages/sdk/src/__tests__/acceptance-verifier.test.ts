import { describe, it, expect } from "vitest";
import type { ModelPort } from "@volto/core";
import { createMockModelPort, textDelta, usage, modelDone } from "@volto/core";
import { parseAcceptanceVerdict, verifyDispatch } from "../acceptance-verifier.js";

describe("parseAcceptanceVerdict", () => {
  it("parses a bare JSON verdict", () => {
    expect(parseAcceptanceVerdict('{"passed":true,"failures":[]}')).toEqual({ status: "passed", failures: [] });
  });
  it("extracts a JSON object wrapped in prose", () => {
    expect(parseAcceptanceVerdict('Here you go:\n{"passed":false,"failures":["no tests"],"retry_hint":"run pnpm test"}\n'))
      .toEqual({ status: "failed", failures: ["no tests"], retryHint: "run pnpm test" });
  });
  it("turns unparseable output into an error verdict, not a failure", () => {
    const v = parseAcceptanceVerdict("looks good to me");
    expect(v.status).toBe("error");
    expect(v.failures).toEqual([]);
    expect(v.verifierError).toBeTruthy();
  });
});

describe("verifyDispatch", () => {
  it("returns the verdict and verifier usage", async () => {
    const port = createMockModelPort([[
      textDelta('{"passed":true,"failures":[]}'), usage(120, 8), modelDone("end_turn"),
    ]]);
    const out = await verifyDispatch({
      modelPort: port, acceptance: "tests pass", task: "do it", output: "done", evidence: "", model: "m",
    });
    expect(out.verdict.status).toBe("passed");
    expect(out.usage).toMatchObject({ inputTokens: 120, outputTokens: 8 });
  });

  it("times out into an error verdict instead of hanging", async () => {
    // eslint-disable-next-line require-yield -- the stall must never yield
    const stall: ModelPort = { async *stream() { await new Promise(() => {}); } };
    const started = Date.now();
    const out = await verifyDispatch({
      modelPort: stall, acceptance: "tests pass", task: "do it", output: "done", evidence: "", timeoutMs: 20,
    });
    expect(out.verdict.status).toBe("error");
    expect(out.verdict.verifierError).toMatch(/timed out/);
    expect(Date.now() - started).toBeLessThan(2000);
  });
});