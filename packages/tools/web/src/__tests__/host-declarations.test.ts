import { describe, it, expect } from "vitest";
import type { Network } from "@volto/core";
import { createWebFetchTool } from "../web-fetch.js";

const networkStub = {} as unknown as Network;

describe("web tool host declarations", () => {
  it("declares url as a host input and nothing else", () => {
    const tool = createWebFetchTool(networkStub);
    expect(tool.definition.hostInputs).toEqual(["url"]);
    expect(tool.definition.pathInputs).toBeUndefined();
  });
});
