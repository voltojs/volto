import { describe, it, expect } from "vitest";
import { createAgent } from "../create-agent.js";
import { textScript } from "@volto/core";
import type { ModelRequest, ModelPort } from "@volto/core";
import { createNodeFileSystem, createNodeShell } from "@volto/runtime-node";

const requests: ModelRequest[] = [];
const modelPort: ModelPort = {
  async *stream(req) {
    requests.push(req);
    yield* textScript("ok");
  },
};

describe("createAgent — plan/read-only ceiling removes write tools from the visible set", () => {
  it("read-only sandbox hides WRITE_HIGH tools from the model request", async () => {
    requests.length = 0;
    const agent = createAgent({
      modelPort,
      fs: createNodeFileSystem({ root: process.cwd() }),
      shell: createNodeShell({ defaultCwd: process.cwd() }),
      permissionConfig: { sandbox: "read-only", approval: "never" },
    });
    await agent.run("go");
    const names = requests[0]!.tools.map((t) => t.name);
    expect(names).not.toContain("write_file");
    expect(names).not.toContain("bash");
    expect(names).toContain("read_file");
    expect(names).toContain("glob");
  });

  it("danger-full-access keeps write tools (unchanged behavior)", async () => {
    requests.length = 0;
    const agent = createAgent({
      modelPort,
      fs: createNodeFileSystem({ root: process.cwd() }),
      shell: createNodeShell({ defaultCwd: process.cwd() }),
      permissionConfig: { sandbox: "danger-full-access", approval: "never" },
    });
    await agent.run("go");
    expect(requests[0]!.tools.map((t) => t.name)).toContain("write_file");
  });
});
