import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { createMockModelPort, textScript, toolCallScript } from "@voltojs/core";
import type { ModelEvent, ModelPort, ModelRequest } from "@voltojs/core";
import { createWiredAgent } from "../wiring.js";
import { buildPermissionConfig, sandboxModeFor } from "../permission-modes.js";

/**
 * T11 real-session evidence: session A remembers a fact through the `memory`
 * tool; a fresh session in the same project retrieves it through the default
 * RAG injection. Both agents go through createWiredAgent (production wiring)
 * with a temp config dir, so the shared file store path is exercised.
 */

const PROJECT_ID = "p1";

let tempConfigDir: string;
let tempProjectDir: string;
let tempHomeDir: string;
let originalConfigDir: string | undefined;
let originalHome: string | undefined;

beforeEach(async () => {
  tempConfigDir = await fs.mkdtemp(path.join(os.tmpdir(), "volto-memory-config-"));
  tempProjectDir = await fs.mkdtemp(path.join(os.tmpdir(), "volto-memory-project-"));
  tempHomeDir = await fs.mkdtemp(path.join(os.tmpdir(), "volto-memory-home-"));
  originalConfigDir = process.env["VOLTO_CONFIG_DIR"];
  process.env["VOLTO_CONFIG_DIR"] = tempConfigDir;
  originalHome = process.env["HOME"];
  process.env["HOME"] = tempHomeDir;
});

afterEach(async () => {
  if (originalConfigDir === undefined) delete process.env["VOLTO_CONFIG_DIR"];
  else process.env["VOLTO_CONFIG_DIR"] = originalConfigDir;
  if (originalHome === undefined) delete process.env["HOME"];
  else process.env["HOME"] = originalHome;
  await fs.rm(tempConfigDir, { recursive: true, force: true });
  await fs.rm(tempProjectDir, { recursive: true, force: true });
  await fs.rm(tempHomeDir, { recursive: true, force: true });
});

function capture(script: ModelEvent[][]): { modelPort: ModelPort; requests: ModelRequest[] } {
  const requests: ModelRequest[] = [];
  const inner = createMockModelPort(script);
  return {
    requests,
    modelPort: {
      async *stream(req) {
        requests.push(structuredClone(req));
        yield* inner.stream(req);
      },
    },
  };
}

function chatMeta() {
  return { projectId: PROJECT_ID, providerId: null, modelId: null, permissionMode: "auto" };
}

async function build(modelPort: ModelPort, chatSessionId: string, projectId: string = PROJECT_ID) {
  return createWiredAgent({
    modelPort,
    cwd: tempProjectDir,
    permissionMode: "auto",
    sandboxMode: sandboxModeFor("auto"),
    permissionConfig: buildPermissionConfig("auto"),
    chatSessionId,
    chatMeta: { ...chatMeta(), projectId },
  });
}

describe("T11 real-session memory", () => {
  it("a fact remembered in project p1 never reaches a p2 session's RAG injection", async () => {
    const sessionA = capture([
      toolCallScript(
        "call-remember",
        "memory",
        JSON.stringify({ action: "remember", text: "The project uses pnpm." }),
      ),
      textScript("Remembered."),
    ]);
    const agentA = await build(sessionA.modelPort, "iso-1");
    try {
      await agentA.run("Remember that this project uses pnpm.");
    } finally {
      await agentA.dispose();
    }

    const sessionB = capture([textScript("no idea")]);
    const agentB = await build(sessionB.modelPort, "iso-2", "p2");
    try {
      await agentB.run("Which package manager does this project use?");
    } finally {
      await agentB.dispose();
    }

    // Isolation is the point of project scoping: p1's memory must not leak
    // into p2's context even though both share the same process-level store.
    const serialized = JSON.stringify(sessionB.requests[0]!.messages);
    expect(serialized).not.toContain("The project uses pnpm.");
  });

  it("remember in session A is retrieved by RAG in a fresh session B of the same project", async () => {
    const sessionA = capture([
      toolCallScript(
        "call-remember",
        "memory",
        JSON.stringify({ action: "remember", text: "The project uses pnpm." }),
      ),
      textScript("Remembered."),
    ]);
    const agentA = await build(sessionA.modelPort, "s1");
    try {
      const state = await agentA.run("Remember that this project uses pnpm.");
      expect(state.status).toBe("done");
    } finally {
      await agentA.dispose();
    }

    const memoryFile = path.join(tempConfigDir, "memory", `${PROJECT_ID}.jsonl`);
    const raw = await fs.readFile(memoryFile, "utf-8");
    expect(raw).toContain("The project uses pnpm.");

    const sessionB = capture([textScript("It uses pnpm.")]);
    const agentB = await build(sessionB.modelPort, "s2");
    try {
      const state = await agentB.run("Which package manager does this project use?");
      expect(state.status).toBe("done");
    } finally {
      await agentB.dispose();
    }

    const request = sessionB.requests[0]!;
    const serialized = JSON.stringify(request.messages);
    expect(serialized).toContain("# Retrieved Memory");
    expect(serialized).toContain("The project uses pnpm.");
    expect(request.tools.map((t) => t.name)).toContain("memory");
  });
});
