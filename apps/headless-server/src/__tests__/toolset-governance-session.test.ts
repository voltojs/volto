import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { createMockModelPort, textScript } from "@volto/core";
import type { ModelEvent, ModelPort, ModelRequest } from "@volto/core";
import { createWiredAgent } from "../wiring.js";
import {
  buildPermissionConfig,
  sandboxModeFor,
  type UiPermissionMode,
} from "../permission-modes.js";

/**
 * F-166 (roadmap F-011) — toolset governance observed on a REAL session
 * built through the gateway wiring, asserted on the tool list the model
 * actually receives (`ModelRequest.tools`).
 *
 * These cases deliberately pass NO `toolVisibility`: the subject is the
 * SDK default that every production session gets (spec 2026-10-15-
 * toolset-governance-design.md, D1/D4). Governance semantics (the cap and
 * the floor) are pinned here; the wiring/assembly intent of older suites
 * is preserved separately via the explicit D5 escape hatch (see
 * lsp-db-session.test.ts).
 */

/** The Task 2 fixture, spawned as the configured language server. */
const LSP_FIXTURE = fileURLToPath(
  new URL(
    "../../../../packages/runtimes/node/src/__tests__/fixtures/lsp-server.mjs",
    import.meta.url,
  ),
);

/** Spec D3: the floor of 14 — must survive the default trim, every name. */
const FLOOR_14 = [
  "read_file",
  "write_file",
  "edit_file",
  "multi_edit",
  "apply_patch",
  "ls",
  "glob",
  "grep",
  "bash",
  "bash_output",
  "kill_shell",
  "git_status",
  "git_diff",
  "git_commit",
] as const;

/** Spec D4 v1.1: the basic tier is guaranteed in a fully assembled session. */
const BASIC_5 = ["task", "task_output", "todo_write", "ask_user", "skill"] as const;

/** Spec D4: the info tier — must never occupy the discretionary slot. */
const INFO_TOOLS = ["web_search", "web_fetch", "read_document", "http_query", "save_plan"] as const;

/** Spec D4: 20 − 14 − 5 = exactly one discretionary slot in a full session. */
const DISCRETIONARY_SLOTS = 1;

let tempConfigDir: string;
let tempProjectDir: string;
let tempHomeDir: string;
let originalConfigDir: string | undefined;
let originalHome: string | undefined;

beforeEach(async () => {
  tempConfigDir = await fs.mkdtemp(path.join(os.tmpdir(), "volto-tg-session-config-"));
  tempProjectDir = await fs.mkdtemp(path.join(os.tmpdir(), "volto-tg-session-project-"));
  tempHomeDir = await fs.mkdtemp(path.join(os.tmpdir(), "volto-tg-session-home-"));
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

async function writeLspConfig(value: unknown): Promise<void> {
  await fs.writeFile(path.join(tempConfigDir, "lsp.json"), JSON.stringify(value), "utf-8");
}

/** Capture every ModelRequest the mock port receives, mirroring lsp-db-session. */
function captureModelPort(scripts: ModelEvent[][]): {
  modelPort: ModelPort;
  requests: ModelRequest[];
} {
  const requests: ModelRequest[] = [];
  const inner = createMockModelPort(scripts);
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

/** Build one real session the way sessions.ts does for the given preset. */
async function buildSession(
  permissionMode: UiPermissionMode,
  modelPort: ModelPort,
): Promise<Awaited<ReturnType<typeof createWiredAgent>>> {
  return createWiredAgent({
    modelPort,
    cwd: tempProjectDir,
    permissionMode,
    sandboxMode: sandboxModeFor(permissionMode),
    permissionConfig: buildPermissionConfig(permissionMode),
  });
}

/** Run one text-only turn and return the tool names the model was offered. */
async function sessionToolNames(permissionMode: UiPermissionMode): Promise<string[]> {
  const { modelPort, requests } = captureModelPort([textScript("ok")]);
  const agent = await buildSession(permissionMode, modelPort);
  try {
    await agent.run("which tools do you have?");
    return requests[0]!.tools.map((tool) => tool.name);
  } finally {
    await agent.dispose();
  }
}

describe("F-166 real session toolset governance (the SDK default, no toolVisibility)", () => {
  it("F-166 a real session shows at most 20 tools with the floor of 14 all present", async () => {
    // Production assembly (no toolVisibility anywhere), default "ask" preset
    // (workspace-write ceiling).
    const tools = await sessionToolNames("ask");

    expect(tools.length).toBeLessThanOrEqual(20);
    // The floor is a set guarantee: every one of the 14 names must be in the
    // visible list — an empty difference is the only honest proof.
    for (const name of FLOOR_14) {
      expect(tools, `floor tool trimmed: ${name}`).toContain(name);
    }
    // v1.1: the basic tier (control / communication channels of the model
    // itself) is guaranteed, not merely prioritized.
    for (const name of BASIC_5) {
      expect(tools, `basic tool trimmed: ${name}`).toContain(name);
    }
    // The honest account: 20 − 14 − 5 leaves at most ONE discretionary slot.
    const discretionary = tools.filter(
      (name) => !(FLOOR_14 as readonly string[]).includes(name) && !(BASIC_5 as readonly string[]).includes(name),
    );
    expect(discretionary.length).toBeLessThanOrEqual(DISCRETIONARY_SLOTS);
  });

  it("F-166 with lsp wired, the single discretionary slot goes to an lsp tool", async () => {
    // A fully configured language server (the runtime-node LSP fixture over
    // real stdio), so opts.lsp is present and the lsp tier joins the table.
    await writeLspConfig({
      servers: { typescript: { command: process.execPath, args: [LSP_FIXTURE] } },
    });

    const tools = await sessionToolNames("ask");

    expect(tools).toHaveLength(20);
    for (const name of FLOOR_14) {
      expect(tools, `floor tool trimmed: ${name}`).toContain(name);
    }
    for (const name of BASIC_5) {
      expect(tools, `basic tool trimmed: ${name}`).toContain(name);
    }
    // The last slot (index 19) is the whole discretionary account: it goes to
    // the lsp tier when lsp is wired — no info or rest name may sit there.
    expect(tools[19]).toMatch(/^lsp_/);
    for (const name of INFO_TOOLS) {
      expect(tools, `info tool occupied the discretionary slot: ${name}`).not.toContain(name);
    }
  });

  it("F-166 read-only mode still caps at 20 (governance is orthogonal to the ceiling)", async () => {
    // permissionMode "read-only" -> READ_ONLY risk ceiling. The ceiling
    // strips the WRITE_LOW / WRITE_HIGH floor members (write_file, edit_file,
    // multi_edit, apply_patch, bash, kill_shell, git_commit) — that is the
    // PERMISSION layer's job (spec §7: governance is not authorization), and
    // it does not lift the governance cap.
    const tools = await sessionToolNames("read-only");

    expect(tools.length).toBeLessThanOrEqual(20);
    // The READ_ONLY floor subset that must survive both layers.
    for (const name of ["read_file", "ls", "glob", "grep", "bash_output", "git_status", "git_diff"]) {
      expect(tools, `read-only floor tool missing: ${name}`).toContain(name);
    }
    // Both mechanisms observable in one list: the ceiling removed the write
    // tools, the governance cap still holds (spec §7 orthogonality).
    expect(tools).not.toContain("write_file");
  });
});
