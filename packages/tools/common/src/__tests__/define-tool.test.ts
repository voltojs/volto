import { describe, it, expect } from "vitest";
import { z } from "zod";
import { defineTool } from "../define-tool.js";

describe("defineTool — parameter declarations", () => {
  it("carries pathInputs and hostInputs into the ToolDefinition", () => {
    const tool = defineTool({
      name: "read_file",
      description: "read",
      schema: z.object({ path: z.string() }),
      requires: ["filesystem:read"],
      riskTier: "READ_ONLY",
      pathInputs: ["path"],
      run: async () => ({ modelContent: "ok" }),
    });
    expect(tool.definition.pathInputs).toEqual(["path"]);
    expect(tool.definition.hostInputs).toBeUndefined();
  });

  it("carries hostInputs for a URL-bearing tool", () => {
    const tool = defineTool({
      name: "web_fetch",
      description: "fetch",
      schema: z.object({ url: z.string() }),
      requires: ["network:fetch"],
      riskTier: "READ_ONLY",
      hostInputs: ["url"],
      run: async () => ({ modelContent: "ok" }),
    });
    expect(tool.definition.hostInputs).toEqual(["url"]);
  });

  it("leaves both undefined when a tool declares neither", () => {
    const tool = defineTool({
      name: "bash",
      description: "run",
      schema: z.object({ command: z.string() }),
      requires: ["shell:exec"],
      riskTier: "WRITE_HIGH",
      run: async () => ({ modelContent: "ok" }),
    });
    expect(tool.definition.pathInputs).toBeUndefined();
    expect(tool.definition.hostInputs).toBeUndefined();
  });

  it("carries commandInputs for a free-text command tool", () => {
    const tool = defineTool({
      name: "bash",
      description: "run",
      schema: z.object({ command: z.string() }),
      requires: ["shell:exec"],
      riskTier: "WRITE_HIGH",
      commandInputs: ["command"],
      run: async () => ({ modelContent: "ok" }),
    });
    expect(tool.definition.commandInputs).toEqual(["command"]);
  });
});
