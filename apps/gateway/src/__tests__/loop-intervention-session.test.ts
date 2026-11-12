import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
  createMockModelPort,
  textScript,
  toolCallScript,
  renderLoopReminder,
  renderLoopIntervention,
} from "@volto/core";
import type { ModelEvent, ModelPort, ModelRequest, Message, PermissionConfig } from "@volto/core";
import { createWiredAgent } from "../wiring.js";
import { buildPermissionConfig, sandboxModeFor } from "../permission-modes.js";

/**
 * F-223 (roadmap F-025 / F-026 runner 运行面) — the three-tier loop ladder
 * observed on a REAL session built through the gateway wiring
 * (`createWiredAgent`), asserted on the provider-bound ModelRequests the
 * model actually received.
 *
 * The session runs with `maxLoopCount: 3` (forwarded through wiring to
 * createAgent's stepContext). Only the ModelPort is scripted, exactly as in
 * spill-session / toolset-governance-session. The scripted rounds:
 *
 *   1-3. the SAME bash call (`isolated: true`, identical input) three times.
 *        The deterministic error source is the production permission layer's
 *        deny path — a `deny` rule on `bash` refuses every call with the
 *        runner-fed `policyDenialMessage` (isError: true). NOTE: bash itself
 *        never sets isError for a non-zero EXIT CODE (it only appends
 *        "(exit code: N)" to modelContent), so `exit 1` alone would classify
 *        as a repeat chain and never reach the intervention tier.
 *   2. round 2 (count = K-1 = 2) books the soft reminder tier — round 3's
 *      request must carry the verbatim `[LOOP REMINDER]` user message.
 *   3. round 3 (count = K = 3, budget 2 > 0) books the intervention tier —
 *      round 4's request must carry the verbatim `[LOOP INTERVENTION]`
 *      user message, AFTER round 3's tool_result (post-batch injection).
 *   4. a DIFFERENT call (read_file on a real workspace file) breaks the
 *      chain — no further injection may fire.
 *   5. text → the turn reaches status "done".
 *
 * The essential wire witness: the real wired session carried the loop
 * reminder AND the loop intervention message into provider-bound
 * ModelRequests.
 */

let tempConfigDir: string;
let tempProjectDir: string;
let tempHomeDir: string;
let originalConfigDir: string | undefined;
let originalHome: string | undefined;

beforeEach(async () => {
  tempConfigDir = await fs.mkdtemp(path.join(os.tmpdir(), "volto-loop-session-config-"));
  tempProjectDir = await fs.mkdtemp(path.join(os.tmpdir(), "volto-loop-session-project-"));
  tempHomeDir = await fs.mkdtemp(path.join(os.tmpdir(), "volto-loop-session-home-"));
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

/** The exact same failing bash call each round — identical input deep-equality. */
const FAILING_BASH_CALL_ID = "c";
function failingBashRound(callId: string): ModelEvent[] {
  return toolCallScript(
    callId,
    "bash",
    JSON.stringify({ command: "exit 1", isolated: true }),
  );
}

/** Text of every user message on the wire, tolerating block-array content. */
function userTexts(messages: readonly Message[]): string[] {
  const texts: string[] = [];
  for (const m of messages) {
    if (m.role !== "user") continue;
    if (typeof m.content === "string") {
      texts.push(m.content);
      continue;
    }
    const joined = m.content
      .map((block) => (block.type === "text" ? block.text : ""))
      .join("");
    texts.push(joined);
  }
  return texts;
}

/** Index of the message carrying a tool_result block with this id. */
function toolResultIndex(messages: readonly Message[], toolUseId: string): number {
  return messages.findIndex((m) => messageHasToolResult(m, toolUseId));
}

/** Whether one message carries a tool_result block with this id. */
function messageHasToolResult(m: Message, toolUseId: string): boolean {
  if (m.role !== "tool" || typeof m.content === "string") return false;
  return m.content.some(
    (block) => block.type === "tool_result" && block.toolUseId === toolUseId,
  );
}

/** The text blocks of the tool_result for `toolUseId` in `messages`. */
function toolResultTexts(messages: readonly Message[], toolUseId: string): string[] {
  for (const m of messages) {
    if (!messageHasToolResult(m, toolUseId) || typeof m.content === "string") continue;
    for (const block of m.content) {
      if (block.type !== "tool_result" || block.toolUseId !== toolUseId) continue;
      return block.content
        .filter((part): part is { type: "text"; text: string } => part.type === "text")
        .map((part) => part.text);
    }
  }
  return [];
}

/** The production permission layer refuses every bash call with isError: true. */
function denyBashPermissionConfig(): PermissionConfig {
  return {
    ...buildPermissionConfig("auto"),
    rules: [{ toolName: "bash", decision: "deny" }],
  };
}

describe("F-223 real session — loop ladder injection on the wire", () => {
  it(
    "F-223/F-026 a real wired session carries [LOOP REMINDER] and [LOOP INTERVENTION] into provider-bound requests, then recovers",
    { timeout: 60_000 },
    async () => {
      // The chain-breaker round reads a REAL workspace file through the
      // real (sandboxed) filesystem — a different tool, a non-error result.
      await fs.writeFile(path.join(tempProjectDir, "probe.txt"), "chain broken\n", "utf-8");

      const { modelPort, requests } = captureModelPort([
        failingBashRound(`${FAILING_BASH_CALL_ID}1`),
        failingBashRound(`${FAILING_BASH_CALL_ID}2`),
        failingBashRound(`${FAILING_BASH_CALL_ID}3`),
        toolCallScript("r4", "read_file", JSON.stringify({ path: "probe.txt" })),
        textScript("loop ladder verified"),
      ]);

      // Production assembly ("auto" preset: workspace-write sandbox + no
      // approval), the SDK default loop budget (maxLoopInterventions = 2),
      // and maxLoopCount 3 wired through the gateway's createWiredAgent.
      const agent = await createWiredAgent({
        modelPort,
        cwd: tempProjectDir,
        maxLoopCount: 3,
        permissionMode: "auto",
        sandboxMode: sandboxModeFor("auto"),
        permissionConfig: denyBashPermissionConfig(),
      });
      let finalStatus: string;
      let finalReminded: number | undefined;
      let finalInterventions: number | undefined;
      try {
        const final = await agent.run("keep retrying the failing bash call, then inspect probe.txt");
        finalStatus = final.status;
        finalReminded = final.loopRemindedCount;
        finalInterventions = final.loopInterventionCount;
      } finally {
        await agent.dispose();
      }

      // Five scripted model calls: three loop rounds, one chain-breaker, one text.
      expect(requests.length).toBe(5);

      // The bash calls really failed on the wire — the error chain the ladder
      // keys on is visible in round 2's request (isError: true tool_result).
      const round2Texts = userTexts(requests[1]!.messages);
      expect(round2Texts.join("\n")).not.toContain("[LOOP REMINDER]");
      expect(round2Texts.join("\n")).not.toContain("[LOOP INTERVENTION]");

      // (a) Soft reminder tier: count = K-1 fires BEFORE the K threshold —
      // round 3's request carries the verbatim reminder, and only then.
      const reminder = renderLoopReminder({
        toolName: "bash",
        consecutiveCount: 2,
        kind: "error",
      });
      expect(reminder.startsWith("[LOOP REMINDER]")).toBe(true);
      const round3Texts = userTexts(requests[2]!.messages);
      expect(round3Texts).toContain(reminder);
      expect(round3Texts.join("\n")).not.toContain("[LOOP INTERVENTION]");

      // (b) Intervention tier: count = K with budget remaining — round 4's
      // request carries the verbatim intervention, injected AFTER round 3's
      // tool_result (post-batch ordering, spec §5).
      const intervention = renderLoopIntervention({
        toolName: "bash",
        consecutiveCount: 3,
      });
      expect(intervention.startsWith("[LOOP INTERVENTION]")).toBe(true);
      const round4Texts = userTexts(requests[3]!.messages);
      expect(round4Texts).toContain(reminder);
      expect(round4Texts).toContain(intervention);
      const interventionIdx = requests[3]!.messages.findIndex(
        (m) =>
          m.role === "user" &&
          (typeof m.content === "string"
            ? m.content.includes("[LOOP INTERVENTION]")
            : false),
      );
      expect(interventionIdx).toBeGreaterThan(-1);
      expect(interventionIdx).toBeGreaterThan(toolResultIndex(requests[3]!.messages, "c3"));

      // The round-3 bash call was genuinely refused with isError on the wire.
      expect(
        requests[3]!.messages.some((m) => messageHasToolResult(m, "c3")),
        "round 3's denied bash tool_result must be on the wire",
      ).toBe(true);

      // (c) The chain-breaker round issued a DIFFERENT call and no further
      // injection fired — exactly one reminder and one intervention in the
      // whole history by round 5's request.
      const round5All = userTexts(requests[4]!.messages).join("\n");
      expect(round5All.match(/\[LOOP REMINDER\]/g)).toHaveLength(1);
      expect(round5All.match(/\[LOOP INTERVENTION\]/g)).toHaveLength(1);
      const r4ResultText = toolResultTexts(requests[4]!.messages, "r4").join("\n");
      expect(r4ResultText).toContain("chain broken");

      // (c') The turn reached the expected terminal state, and the real
      // session's ladder bookkeeping matches one reminder + one intervention.
      expect(finalStatus).toBe("done");
      expect(finalReminded).toBe(2);
      expect(finalInterventions).toBe(1);
    },
  );
});
