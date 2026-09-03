import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import { createWiredAgent } from "../wiring.js";
import { createMockModelPort, textScript } from "@volto/core";
import type { ModelPort, ModelRequest } from "@volto/core";

let tempConfigDir: string;
let tempProjectDir: string;
let originalConfigDir: string | undefined;

beforeEach(async () => {
  tempConfigDir = await fs.mkdtemp(path.join(os.tmpdir(), "wiring-config-"));
  tempProjectDir = await fs.mkdtemp(path.join(os.tmpdir(), "wiring-project-"));
  originalConfigDir = process.env["VOLTO_CONFIG_DIR"];
  process.env["VOLTO_CONFIG_DIR"] = tempConfigDir;
});

afterEach(async () => {
  if (originalConfigDir === undefined) delete process.env["VOLTO_CONFIG_DIR"];
  else process.env["VOLTO_CONFIG_DIR"] = originalConfigDir;
  await fs.rm(tempConfigDir, { recursive: true, force: true });
  await fs.rm(tempProjectDir, { recursive: true, force: true });
});

function captureModelPort(): { modelPort: ModelPort; requests: ModelRequest[] } {
  const requests: ModelRequest[] = [];
  const inner = createMockModelPort([textScript("ok")]);
  return {
    requests,
    modelPort: {
      async *stream(req) {
        requests.push(req);
        yield* inner.stream(req);
      },
    },
  };
}

describe("createWiredAgent memory file layers", () => {
  it("includes both user and project AGENTS.md as separate system messages", async () => {
    await fs.writeFile(path.join(tempConfigDir, "AGENTS.md"), "User rule", "utf-8");
    await fs.writeFile(path.join(tempProjectDir, "AGENTS.md"), "Project rule", "utf-8");
    const { modelPort, requests } = captureModelPort();

    const agent = createWiredAgent({ modelPort, cwd: tempProjectDir });
    await agent.run("hi");

    const systemContents = requests[0]!.messages
      .filter((m) => m.role === "system")
      .map((m) => (m as { content: string }).content);
    expect(systemContents).toContain("User rule");
    expect(systemContents).toContain("Project rule");
    // Two distinct messages, not merged into one.
    expect(systemContents.filter((c) => c.includes("rule"))).toHaveLength(2);
  });

  it("omits a layer entirely when its file does not exist, without erroring", async () => {
    // Neither AGENTS.md file is created in this test.
    const { modelPort, requests } = captureModelPort();

    const agent = createWiredAgent({ modelPort, cwd: tempProjectDir });
    await agent.run("hi");

    const systemContents = requests[0]!.messages
      .filter((m) => m.role === "system")
      .map((m) => (m as { content: string }).content);
    expect(systemContents.some((c) => c.includes("missing instruction file"))).toBe(false);
  });
});
