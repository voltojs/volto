import { describe, it, expect } from "vitest";
import type { Network } from "@volto/core";
import { createHttpQueryTool } from "../index.js";

const networkStub = {} as unknown as Network;

describe("data tool host declarations", () => {
  it("declares url as a host input and nothing else", () => {
    const tool = createHttpQueryTool(networkStub);
    expect(tool.definition.hostInputs).toEqual(["url"]);
    expect(tool.definition.pathInputs).toBeUndefined();
  });
});
