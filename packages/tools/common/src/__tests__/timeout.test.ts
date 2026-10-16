import { describe, it, expect } from "vitest";
import { DEFAULT_TIMEOUTS, renderTimeoutSignature } from "../timeout.js";

describe("renderTimeoutSignature", () => {
  it("renders the unified signature verbatim with subject and N injection (spec D3)", () => {
    expect(renderTimeoutSignature("bash", 30_000)).toBe(
      "[timeout] bash timed out after 30000ms",
    );
    // Subject and N are both injectable — byte template must not drift
    // (runtime-node holds the same-byte copy for its network layer).
    expect(renderTimeoutSignature("web_fetch", 500)).toBe(
      "[timeout] web_fetch timed out after 500ms",
    );
  });
});

describe("DEFAULT_TIMEOUTS", () => {
  it("declares the tool and network layer defaults as const numbers", () => {
    expect(DEFAULT_TIMEOUTS).toEqual({ tool: 30_000, network: 30_000 });
    expect(typeof DEFAULT_TIMEOUTS.tool).toBe("number");
    expect(typeof DEFAULT_TIMEOUTS.network).toBe("number");
  });
});
