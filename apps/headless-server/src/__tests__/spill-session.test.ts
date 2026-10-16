import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { textScript, toolCallScript } from "@volto/core";
import type { ModelEvent, ModelPort, ModelRequest } from "@volto/core";
import { createWiredAgent } from "../wiring.js";
import { buildPermissionConfig, sandboxModeFor } from "../permission-modes.js";

/**
 * F-186 (roadmap F-016 ~ F-020) — spill observed on a REAL session built
 * through the gateway wiring (`createWiredAgent`), asserted on the
 * ModelRequests the model actually received and on the spill file that
 * really lands on disk under the project root.
 *
 * The session runs the REAL bash tool through the REAL sandbox path; only
 * the ModelPort is scripted, exactly as in toolset-governance-session and
 * subagent-envelope-session. The scripted rounds:
 *
 *   1. bash `seq 1 20000` with show_full_output (108_894 chars > the
 *      16_000 threshold; without show_full_output the bash tool's own
 *      100_000 cap would truncate first and the spilled file would lose
 *      the `20000` tail line this test proves recoverable).
 *   2. Round 2's request must carry head(2000) + the spill reference
 *      verbatim; the round issues read_file on the extracted path
 *      (offset/limit paginates read_file's 2_000-line window to the tail).
 *   3. Round 3's request must carry the read_file tail; the round ends
 *      the turn.
 *
 * Then: the turn status is "done" and the spill file on disk holds the
 * full stdout verbatim.
 */

let tempConfigDir: string;
let tempProjectDir: string;
let tempHomeDir: string;
let originalConfigDir: string | undefined;
let originalHome: string | undefined;

beforeEach(async () => {
  tempConfigDir = await fs.mkdtemp(path.join(os.tmpdir(), "volto-spill-session-config-"));
  tempProjectDir = await fs.mkdtemp(path.join(os.tmpdir(), "volto-spill-session-project-"));
  tempHomeDir = await fs.mkdtemp(path.join(os.tmpdir(), "volto-spill-session-home-"));
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

/** The exact stdout `seq 1 20000` produces — one `\n`-terminated line per number. */
const SEQ_LINES = 20_000;
function seqOutput(): string {
  let out = "";
  for (let i = 1; i <= SEQ_LINES; i++) out += `${i}\n`;
  return out;
}

/**
 * The spill reference appended to an oversized result. The format string is
 * a cross-package contract (core's renderSpillReference) — matched verbatim.
 */
const SPILL_REF_RE =
  /\[output truncated: (\d+) chars total; full output saved to (\S+) — read it with read_file if needed\]/;

/**
 * Per-call scripted capture port: each step receives the ModelRequest the
 * session actually made, so extraction (the spill path) can route the next
 * round. Assertions land AFTER the run on the captured requests, keeping
 * failure output concise and pinpointed.
 */
function scriptedCapturePort(steps: Array<(req: ModelRequest) => ModelEvent[]>): {
  modelPort: ModelPort;
  requests: ModelRequest[];
} {
  const requests: ModelRequest[] = [];
  let index = 0;
  return {
    requests,
    modelPort: {
      async *stream(req) {
        requests.push(req);
        const step = steps[index];
        index++;
        if (!step) throw new Error(`no scripted step for model call ${index - 1}`);
        yield* step(req);
      },
    },
  };
}

/**
 * The text blocks of the tool_result for `toolUseId` in `request` — the
 * exact block array the provider-bound request carries. Throws when the
 * tool result is missing: an absent result must fail loudly, never pass
 * as empty output.
 */
function toolResultTextBlocks(request: ModelRequest, toolUseId: string): string[] {
  for (const m of request.messages) {
    if (m.role !== "tool" || typeof m.content === "string") continue;
    for (const block of m.content) {
      if (block.type !== "tool_result" || block.toolUseId !== toolUseId) continue;
      return block.content
        .filter((part): part is { type: "text"; text: string } => part.type === "text")
        .map((part) => part.text);
    }
  }
  throw new Error(`no tool_result for ${toolUseId} in request`);
}

describe("F-186 real session — SDK-wired tool-result spill", () => {
  it(
    "F-186 oversized bash result spills to disk; read_file recovers the tail in the same session",
    { timeout: 60_000 },
    async () => {
      const expected = seqOutput();
      // Extracted during round 2 (the only place the reference exists while
      // the run is in flight); asserted verbatim after the run.
      let spillPath = "";

      const { modelPort, requests } = scriptedCapturePort([
        // Round 1: full seq output — over the 16_000 spill threshold.
        () =>
          toolCallScript(
            "c1",
            "bash",
            JSON.stringify({ command: `seq 1 ${SEQ_LINES}`, show_full_output: true }),
          ),
        // Round 2: extract the spill reference path and issue read_file on
        // it. offset/limit pages read_file's 2_000-line window to the tail.
        (req) => {
          const match = SPILL_REF_RE.exec(toolResultTextBlocks(req, "c1").join(""));
          if (match) spillPath = match[2] ?? "";
          return toolCallScript(
            "c2",
            "read_file",
            JSON.stringify({ path: spillPath, offset: 19990, limit: 11 }),
          );
        },
        // Round 3: end the turn; the read_file tail lands in request 3.
        () => textScript("spill round-trip verified"),
      ]);

      // Production assembly, permission preset "auto" (workspace-write
      // sandbox, approval never): bash must execute for real without a HITL
      // pause, through the same sandbox path production sessions use.
      const agent = await createWiredAgent({
        modelPort,
        cwd: tempProjectDir,
        permissionMode: "auto",
        sandboxMode: sandboxModeFor("auto"),
        permissionConfig: buildPermissionConfig("auto"),
      });
      let finalStatus: string;
      try {
        const final = await agent.run("dump the sequence, then inspect the saved tail");
        finalStatus = final.status;
      } finally {
        await agent.dispose();
      }

      expect(requests.length).toBe(3);

      // Round 2's request: the bash tool_result is head + reference, NEVER
      // the full output. The length bound is the concise RED signature
      // (unwired spill inlines all 108_894 chars).
      const bashText = toolResultTextBlocks(requests[1]!, "c1").join("");
      expect(
        bashText.length,
        `bash tool_result was not spilled — ${bashText.length} chars inline`,
      ).toBeLessThan(3_000);

      const head = expected.slice(0, 2_000);
      expect(bashText.startsWith(head)).toBe(true);

      const refMatch = SPILL_REF_RE.exec(bashText);
      expect(refMatch, "no spill reference in the bash tool_result").not.toBeNull();
      if (refMatch === null) throw new Error("unreachable: assertion above throws");
      const totalChars = Number(refMatch[1]);
      const refPath = refMatch[2]!;
      expect(totalChars).toBe(expected.length);
      // Reference path shape: workspace-relative .volto/spill/<sessionId>/c1.txt.
      expect(refPath).toMatch(/^\.volto\/spill\/[^/]+\/c1\.txt$/);
      // Verbatim: the whole inline text is exactly head + "\n\n" + reference.
      expect(bashText).toBe(
        `${head}\n\n[output truncated: ${totalChars} chars total; full output saved to ${refPath} — read it with read_file if needed]`,
      );
      // Round 2 really issued read_file on the extracted path.
      expect(spillPath).toBe(refPath);

      // Round 3's request: the read_file tool_result carries the TAIL of
      // the spilled content (line-number prefixes, so fragment containment
      // rather than byte equality).
      const readText = toolResultTextBlocks(requests[2]!, "c2").join("");
      expect(readText).toContain("19999\t19999");
      expect(readText).toContain("20000\t20000");

      // The spill file really exists under the temp project dir, holding
      // the full output verbatim.
      const onDisk = await fs.readFile(path.join(tempProjectDir, refPath), "utf8");
      expect(onDisk).toBe(expected);

      // The turn completed cleanly — the loop was never interrupted.
      expect(finalStatus).toBe("done");
    },
  );
});
