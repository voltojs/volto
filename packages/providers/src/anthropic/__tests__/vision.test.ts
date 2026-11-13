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

  it("publishes family-derived input for a known model", async () => {
    const info = await port.describeModel!("claude-3-5-sonnet-latest");
    expect(info.input).toEqual(["text", "image"]);
  });

  it("lets an explicit options.input override the family heuristic", async () => {
    const forced = createAnthropicModelPort({ apiKey: "k", input: ["text"] });
    const info = await forced.describeModel!("claude-3-5-sonnet-latest");
    expect(info.input).toEqual(["text"]);
  });

  it("leaves input absent for an unknown model id", async () => {
    const info = await port.describeModel!("mystery-model");
    expect(info.input).toBeUndefined();
  });
});
