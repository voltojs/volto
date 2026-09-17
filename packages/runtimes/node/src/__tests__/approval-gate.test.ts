import { describe, it, expect } from "vitest";
import { createSubAgentApprovalGate, createAutoAllowGate } from "../approval-gate.js";

describe("createSubAgentApprovalGate", () => {
  it("denies instead of auto-allowing an ask decision", async () => {
    const gate = createSubAgentApprovalGate();
    const decision = await gate.ask(
      { id: "c1", name: "write_file", input: { path: "/tmp/x", content: "data" } },
      "WRITE_HIGH",
    );
    expect(decision).toBe("deny");
  });

  it("differs from the auto-allow gate used for the parent", async () => {
    const auto = createAutoAllowGate();
    const sub = createSubAgentApprovalGate();
    const call = { id: "c2", name: "bash", input: { command: "rm -rf /" } };
    expect(await auto.ask(call, "WRITE_HIGH")).toBe("allow");
    expect(await sub.ask(call, "WRITE_HIGH")).toBe("deny");
  });
});
