import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
  createMockModelPort,
  textScript,
  toolCallScript,
} from "@voltojs/core";
import type {
  ModelEvent,
  ModelPort,
  ModelRequest,
  Message,
  ToolResultContent,
} from "@voltojs/core";
import { createWiredAgent } from "../wiring.js";
import { buildPermissionConfig, sandboxModeFor } from "../permission-modes.js";

/**
 * F-235 (roadmap F-029 runner/model-request face) — the unified timeout
 * signature observed on a REAL session built through the gateway wiring
 * (`createWiredAgent`), asserted on the provider-bound ModelRequests the
 * model actually received. This is the §0.1 criteria 2/3 wire witness T8
 * taught us not to leave to report-time adjudication.
 *
 * The session runs with the production "auto" preset: a workspace-write
 * sandbox (the SDK wraps the shell AND the persistent-session spawner from
 * that one knob — same boundary the exec path gets) and an auto-allow
 * approval policy. Only the ModelPort is scripted, exactly as in
 * loop-intervention-session. The scripted rounds:
 *
 *   1. bash `{ command: "sleep 10", timeout: 500 }` — the per-call `timeout`
 *      is a MODEL-INPUT field on the bash schema, so the scripted model
 *      passes a small value. The command executes for real through the
 *      real shell / persistent session inside the real sandbox; the short
 *      kill is the session's own stuck-command recovery (SIGINT → grace →
 *      SIGKILL → rebuild), whose result carries `timedOut: true` (T9-02).
 *   2. round 2's request MUST carry round 1's tool_result: verbatim
 *      `[timeout] bash timed out after 500ms` AND `isError: true` — the
 *      wire witness for F-029's real-session face. Round 2 then issues a
 *      DIFFERENT, fast bash call, proving the timeout did not poison the
 *      loop (AGENTS.md §2.3: errors normalize into the feed, never abort
 *      the turn) and that the rebuilt session still executes.
 *   3. round 3's request carries both tool_results; assert the recovery
 *      round succeeded, then text → the turn reaches status "done".
 *
 * Dialect discipline (AGENTS.md §2.1): the assertions pin the timeout
 * signature itself — a positive fact the timeout path MUST produce — never
 * "output empty", which every dead runner also produces. If a sandbox
 * backend ever refused `sleep` outright, the honest witness would be that
 * refusal's own non-zero exit + dialect signature, not this test.
 */

let tempConfigDir: string;
let tempProjectDir: string;
let tempHomeDir: string;
let originalConfigDir: string | undefined;
let originalHome: string | undefined;

beforeEach(async () => {
  tempConfigDir = await fs.mkdtemp(path.join(os.tmpdir(), "volto-timeout-session-config-"));
  tempProjectDir = await fs.mkdtemp(path.join(os.tmpdir(), "volto-timeout-session-project-"));
  tempHomeDir = await fs.mkdtemp(path.join(os.tmpdir(), "volto-timeout-session-home-"));
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

/** Whether one message carries a tool_result block with this id. */
function messageHasToolResult(m: Message, toolUseId: string): boolean {
  if (m.role !== "tool" || typeof m.content === "string") return false;
  return m.content.some(
    (block) => block.type === "tool_result" && block.toolUseId === toolUseId,
  );
}

/** The tool_result block for `toolUseId` in `messages`, if present. */
function toolResultBlock(
  messages: readonly Message[],
  toolUseId: string,
): ToolResultContent | undefined {
  for (const m of messages) {
    if (!messageHasToolResult(m, toolUseId) || typeof m.content === "string") continue;
    for (const block of m.content) {
      if (block.type === "tool_result" && block.toolUseId === toolUseId) return block;
    }
  }
  return undefined;
}

/** The text blocks of the tool_result for `toolUseId` in `messages`. */
function toolResultTexts(messages: readonly Message[], toolUseId: string): string[] {
  const block = toolResultBlock(messages, toolUseId);
  if (!block) return [];
  return block.content
    .filter((part): part is { type: "text"; text: string } => part.type === "text")
    .map((part) => part.text);
}

describe("F-235 real session — bash timeout signature on the wire", () => {
  it(
    "F-235/F-029 a real wired session feeds the bash timeout back as isError with the verbatim [timeout] signature",
    { timeout: 60_000 },
    async () => {
      const { modelPort, requests } = captureModelPort([
        toolCallScript(
          "c1",
          "bash",
          JSON.stringify({ command: "sleep 10", timeout: 500 }),
        ),
        toolCallScript("c2", "bash", JSON.stringify({ command: "echo timeout-recovered" })),
        textScript("timeout observed, session recovered"),
      ]);

      // Production assembly ("auto" preset: workspace-write sandbox + no
      // approval) through the gateway's createWiredAgent. bash needs no
      // special config beyond that.
      const agent = await createWiredAgent({
        modelPort,
        cwd: tempProjectDir,
        permissionMode: "auto",
        sandboxMode: sandboxModeFor("auto"),
        permissionConfig: buildPermissionConfig("auto"),
      });
      let finalStatus: string;
      try {
        const final = await agent.run("run the long sleep, then verify the shell still works");
        finalStatus = final.status;
      } finally {
        await agent.dispose();
      }

      // Three scripted model calls: timeout round, recovery round, text.
      expect(requests.length).toBe(3);

      // The wire witness: round 2's request carries round 1's timeout
      // result — the verbatim unified signature AND isError: true, the
      // model-request face of F-029 through the real sandbox kill path.
      const round2Block = toolResultBlock(requests[1]!.messages, "c1");
      expect(round2Block, "round 1's timeout tool_result must be on the wire").toBeDefined();
      const round2Texts = toolResultTexts(requests[1]!.messages, "c1").join("\n");
      expect(round2Texts).toContain("[timeout] bash timed out after 500ms");
      expect(round2Block!.isError).toBe(true);

      // The error normalized into the feed instead of aborting the turn
      // (AGENTS.md §2.3): round 2 ran a DIFFERENT, fast bash call through
      // the rebuilt session, and round 3's request carries its success.
      const round3Texts = toolResultTexts(requests[2]!.messages, "c2").join("\n");
      expect(round3Texts).toContain("timeout-recovered");
      const round3C1 = toolResultBlock(requests[2]!.messages, "c1");
      expect(round3C1?.isError).toBe(true);
      expect(toolResultTexts(requests[2]!.messages, "c1").join("\n")).toContain(
        "[timeout] bash timed out after 500ms",
      );

      // The turn reached the expected terminal state.
      expect(finalStatus).toBe("done");
    },
  );
});
