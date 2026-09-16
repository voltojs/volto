import { describe, it, expect } from "vitest";
import { createOpenAIModelPort, openaiFamilyVision } from "../model-port.js";

describe("openaiFamilyVision", () => {
  it("marks known vision-capable OpenAI families", () => {
    expect(openaiFamilyVision("gpt-4o")).toBe(true);
    expect(openaiFamilyVision("gpt-4o-mini")).toBe(true);
    expect(openaiFamilyVision("gpt-4-turbo")).toBe(true);
    expect(openaiFamilyVision("gpt-4.1-mini")).toBe(true);
    expect(openaiFamilyVision("o4-mini")).toBe(true);
  });

  it("marks gpt-3.5 as text-only", () => {
    expect(openaiFamilyVision("gpt-3.5-turbo")).toBe(false);
  });

  it("leaves bare gpt-4 and gateway ids absent (UNKNOWN, not false)", () => {
    expect(openaiFamilyVision("gpt-4")).toBeUndefined();
    expect(openaiFamilyVision("my-vllm-llava")).toBeUndefined();
  });
});

describe("createOpenAIModelPort.describeModel", () => {
  const port = createOpenAIModelPort({ apiKey: "k" });

  it("publishes family-derived vision for a known model", async () => {
    const info = await port.describeModel!("gpt-4o-mini");
    expect(info.model).toBe("gpt-4o-mini");
    expect(info.vision).toBe(true);
  });

  it("lets an explicit options.vision override the family heuristic", async () => {
    const forced = createOpenAIModelPort({ apiKey: "k", vision: true });
    const info = await forced.describeModel!("my-vllm-llava");
    expect(info.vision).toBe(true);
  });

  it("leaves vision absent for an unknown gateway model", async () => {
    const info = await port.describeModel!("xiaomi-mimo-v2.5");
    expect(info.vision).toBeUndefined();
  });
});
