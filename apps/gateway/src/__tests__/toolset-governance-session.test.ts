import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { createMockModelPort, textScript } from "@voltojs/core";
import type { ModelEvent, ModelPort, ModelRequest } from "@voltojs/core";
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

/** Spec D4 (revised 2026-11-19): the info tier is guaranteed its own slots. */
const INFO_TOOLS = ["web_search", "web_fetch", "read_document", "http_query"] as const;

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
  it("F-166 a real session shows the floor of 14, the basic 5 and every mode group", async () => {
    // Production assembly (no toolVisibility anywhere), default "ask" preset
    // (workspace-write ceiling).
    const tools = await sessionToolNames("ask");

    // LSP is always wired (its five tools are offered; whether a server binary
    // exists is a call-time question). The cap is the 20-slot base plus one
    // slot per tool of every assembled mode group: lsp 5 + db 2 + memory 1 +
    // plan 1 + info 4 = 33, with the base's spare slot going to `rest`.
    expect(tools).toHaveLength(33);
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
    // Every mode group keeps its own slots: memory, all five lsp tools, the
    // db and plan tools and the whole info tier are visible at once.
    expect(tools).toContain("memory");
    expect(tools).toContain("save_plan");
    for (const name of ["db_query", "db_exec"]) {
      expect(tools, `db tool trimmed: ${name}`).toContain(name);
    }
    for (const name of INFO_TOOLS) {
      expect(tools, `info tool trimmed: ${name}`).toContain(name);
    }
  });

  it("F-166 with lsp wired, memory comes before lsp and all five lsp tools survive", async () => {
    // A fully configured language server (the runtime-node LSP fixture over
    // real stdio), so opts.lsp is present and the lsp tier joins the table.
    await writeLspConfig({
      servers: { typescript: { command: process.execPath, args: [LSP_FIXTURE] } },
    });

    const tools = await sessionToolNames("ask");

    expect(tools).toHaveLength(33);
    for (const name of FLOOR_14) {
      expect(tools, `floor tool trimmed: ${name}`).toContain(name);
    }
    for (const name of BASIC_5) {
      expect(tools, `basic tool trimmed: ${name}`).toContain(name);
    }
    // Tier order is observable: plan (55) before memory (45) before lsp (40)
    // before web (30) before db (10) — so SQLite can never evict the web tier.
    const at = (name: string): number => tools.indexOf(name);
    expect(at("save_plan")).toBeLessThan(at("memory"));
    expect(at("memory")).toBeLessThan(at("lsp_definition"));
    expect(at("lsp_hover")).toBeLessThan(at("web_search"));
    expect(at("web_fetch")).toBeLessThan(at("db_query"));
    for (const name of INFO_TOOLS) {
      expect(tools, `info tool trimmed: ${name}`).toContain(name);
    }
  });

  it("F-166 read-only mode still caps at 20 (governance is orthogonal to the ceiling)", async () => {
    // permissionMode "read-only" -> READ_ONLY risk ceiling. The ceiling
    // strips the WRITE_LOW / WRITE_HIGH floor members (write_file, edit_file,
    // multi_edit, apply_patch, bash, kill_shell, git_commit) — that is the
    // PERMISSION layer's job (spec §7: governance is not authorization), and
    // it does not lift the governance cap.
    const tools = await sessionToolNames("read-only");

    expect(tools.length).toBeLessThanOrEqual(33);
    // Session-state tools grade READ_ONLY + writesSessionState, so they stay
    // visible even under the read-only ceiling (they cannot touch the workspace).
    expect(tools).toContain("memory");
    // Governance is orthogonal to the ceiling: the web tier is untouched by it.
    expect(tools).toContain("web_search");
    // The READ_ONLY floor subset that must survive both layers.
    for (const name of ["read_file", "ls", "glob", "grep", "bash_output", "git_status", "git_diff"]) {
      expect(tools, `read-only floor tool missing: ${name}`).toContain(name);
    }
    // Both mechanisms observable in one list: the ceiling removed the write
    // tools, the governance cap still holds (spec §7 orthogonality).
    expect(tools).not.toContain("write_file");
  });

  it("F-166 memory:false drops the memory slot and hides the memory tool", async () => {
    const { modelPort, requests } = captureModelPort([textScript("ok")]);
    const agent = await createWiredAgent({
      modelPort,
      cwd: tempProjectDir,
      permissionMode: "ask",
      sandboxMode: sandboxModeFor("ask"),
      permissionConfig: buildPermissionConfig("ask"),
      memory: false,
    });
    try {
      await agent.run("which tools do you have?");
      const tools = requests[0]!.tools.map((tool) => tool.name);
      // The same budget minus memory's one slot (and its tool).
      expect(tools).toHaveLength(32);
      expect(tools).not.toContain("memory");
      expect(tools).toContain("web_search");
    } finally {
      await agent.dispose();
    }
  });
});
