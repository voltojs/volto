import { describe, it, expect } from "vitest";
import { createAnthropicModelPort, anthropicFamilyVision } from "../model-port.js";

describe("anthropicFamilyVision", () => {
  it("marks Claude 3+ families as vision-capable", () => {
    expect(anthropicFamilyVision("claude-3-opus-20240229")).toBe(true);
    expect(anthropicFamilyVision("claude-3-5-sonnet-20241022")).toBe(true);
    expect(anthropicFamilyVision("claude-sonnet-4-20250514")).toBe(true);
    expect(anthropicFamilyVision("claude-haiku-4-5")).toBe(true);
  });

  it("marks Claude 2 / Instant as text-only", () => {
    expect(anthropicFamilyVision("claude-2.1")).toBe(false);
    expect(anthropicFamilyVision("claude-instant-1.2")).toBe(false);
  });

  it("leaves unrecognized ids absent (UNKNOWN, not false)", () => {
    expect(anthropicFamilyVision("my-proxy-claude")).toBeUndefined();
    expect(anthropicFamilyVision("gpt-4o")).toBeUndefined();
  });
});

describe("createAnthropicModelPort.describeModel", () => {
  const port = createAnthropicModelPort({ apiKey: "k" });

  it("publishes family-derived vision for a known model", async () => {
    const info = await port.describeModel!("claude-sonnet-4-20250514");
    expect(info.model).toBe("claude-sonnet-4-20250514");
    expect(info.vision).toBe(true);
  });

  it("lets an explicit options.vision override the family heuristic", async () => {
    const forced = createAnthropicModelPort({ apiKey: "k", vision: false });
    const info = await forced.describeModel!("claude-sonnet-4-20250514");
    expect(info.vision).toBe(false);
  });

  it("leaves vision absent for an unknown model id", async () => {
    const info = await port.describeModel!("acme-claude-clone");
    expect(info.vision).toBeUndefined();
  });
});
