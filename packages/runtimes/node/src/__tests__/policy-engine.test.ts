import { describe, it, expect } from "vitest";
import {
  createAllowAllPolicyEngine,
  createRuleBasedPolicyEngine,
} from "../policy-engine.js";

describe("createAllowAllPolicyEngine", () => {
  it("allows any request", async () => {
    const engine = createAllowAllPolicyEngine();
    expect(await engine.evaluate({ action: "bash" })).toBe("allow");
    expect(await engine.evaluate({ action: "rm_rf", context: { confirm: true } })).toBe("allow");
  });
});

describe("createRuleBasedPolicyEngine", () => {
  it("matches exact action", async () => {
    const engine = createRuleBasedPolicyEngine([
      { action: "bash", decision: "deny" },
    ]);
    expect(await engine.evaluate({ action: "bash" })).toBe("deny");
  });

  it("matches pattern with * suffix", async () => {
    const engine = createRuleBasedPolicyEngine([
      { action: "db_*", decision: "ask" },
    ]);
    expect(await engine.evaluate({ action: "db_query" })).toBe("ask");
    expect(await engine.evaluate({ action: "db_exec" })).toBe("ask");
  });

  it("falls back to ask for unmatched actions", async () => {
    const engine = createRuleBasedPolicyEngine([
      { action: "bash", decision: "deny" },
    ]);
    expect(await engine.evaluate({ action: "read_file" })).toBe("ask");
  });

  it("first matching rule wins", async () => {
    const engine = createRuleBasedPolicyEngine([
      { action: "bash", decision: "deny" },
      { action: "bash", decision: "allow" },
    ]);
    expect(await engine.evaluate({ action: "bash" })).toBe("deny");
  });

  it("pattern prefix match", async () => {
    const engine = createRuleBasedPolicyEngine([
      { action: "lsp_*", decision: "allow" },
    ]);
    expect(await engine.evaluate({ action: "lsp_definition" })).toBe("allow");
    expect(await engine.evaluate({ action: "lsp_references" })).toBe("allow");
    expect(await engine.evaluate({ action: "bash" })).toBe("ask"); // no match
  });
});
