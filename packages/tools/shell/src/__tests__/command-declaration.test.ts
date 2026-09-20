import { describe, it, expect } from "vitest";
import type { Shell } from "@volto/core";
import { createBashTool } from "../bash.js";

const shellStub = {} as unknown as Shell;

describe("bash command input declaration", () => {
  it("declares the command field so command rules can match it", () => {
    const tool = createBashTool(shellStub);
    expect(tool.definition.commandInputs).toEqual(["command"]);
  });

  it("declares only fields that exist in the input schema", () => {
    const tool = createBashTool(shellStub);
    const properties = Object.keys(tool.definition.inputSchema.properties ?? {});
    for (const field of tool.definition.commandInputs ?? []) {
      expect(properties).toContain(field);
    }
  });
});
