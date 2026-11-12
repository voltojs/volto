import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
  createMockModelPort,
  textScript,
  toolCallScript,
} from "@volto/core";
import type {
  ModelEvent,
  ModelPort,
  ModelRequest,
  Message,
  ToolResultContent,
} from "@volto/core";
import { createWiredAgent } from "../wiring.js";
import { buildPermissionConfig, sandboxModeFor } from "../permission-modes.js";

/**
 * F-244 (roadmap F-030 real-session face + F-034) — a hooks.json command
 * hook observed on a REAL session built through the gateway wiring
 * (`createWiredAgent`), asserted on the provider-bound ModelRequests the
 * model actually received.
 *
 * The session reads hooks.json from the isolated VOLTO_CONFIG_DIR — the
 * same config-dir load discipline as egress.json / permissions.json
 * (re-read per session build). Only the ModelPort is scripted, exactly as
 * in timeout-signature-session / loop-intervention-session. The scripted
 * rounds:
 *
 *   1. (deny case) a real `bash` tool_use. The configured preToolUse hook
 *      (a REAL child process: a script that exits 2 with a stderr reason)
 *      denies it BEFORE the executor runs — the tool_result fed back to
 *      the model is the runner's hook-denial normalization: the verbatim
 *      `Tool "bash" was denied by a preToolUse hook: <reason>` header plus
 *      the "Do not route around the refusal" paragraph, `isError: true`.
 *      Round 2's request carries it: the wire witness that config hooks
 *      are compiled, executed, and enforced in a real session.
 *   2. (allow case) the same harness with an `exit 0` hook — the bash
 *      call executes for real through the real sandboxed shell and the
 *      tool_result carries its real stdout.
 *
 * Dialect discipline (AGENTS.md §2.1): the deny assertions pin the denial
 * text itself — a positive fact the deny path MUST produce — never "output
 * empty". The allow case pins the hook's own continue semantics (exit 0)
 * against the tool's real output, so neither case can pass on a dead
 * runner or a misfiring hook.
 */

let tempConfigDir: string;
let tempProjectDir: string;
let tempHomeDir: string;
let originalConfigDir: string | undefined;
let originalHome: string | undefined;

beforeEach(async () => {
  tempConfigDir = await fs.mkdtemp(path.join(os.tmpdir(), "volto-hooks-session-config-"));
  tempProjectDir = await fs.mkdtemp(path.join(os.tmpdir(), "volto-hooks-session-project-"));
  tempHomeDir = await fs.mkdtemp(path.join(os.tmpdir(), "volto-hooks-session-home-"));
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

/** Write an executable hook script into the temp config dir, return its path. */
async function writeHookScript(name: string, body: string): Promise<string> {
  const scriptPath = path.join(tempConfigDir, name);
  await fs.writeFile(scriptPath, body, "utf-8");
  await fs.chmod(scriptPath, 0o755);
  return scriptPath;
}

/** Write hooks.json into the isolated config dir. */
async function writeHooksConfig(config: Record<string, unknown>): Promise<void> {
  await fs.writeFile(
    path.join(tempConfigDir, "hooks.json"),
    JSON.stringify(config),
    "utf-8",
  );
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

/**
 * The runner's preToolUse denial normalization, verbatim (runner.ts
 * executeTool): the header names the tool and the hook reason, the
 * paragraph tells the model not to route around the refusal. F-034 pins
 * this byte-identical in the runtime-node unit tests; here it is the
 * REAL-session wire shape, reason from a REAL hook child process's stderr.
 */
function expectedDenialText(reason: string): string {
  return (
    `Tool "bash" was denied by a preToolUse hook: ${reason}\n\n` +
    `A hook is a rule this deployment installed deliberately, not a ` +
    `failure of the tool. Do not route around the refusal: do not reach ` +
    `the refused effect through another tool, and in particular do not ` +
    `use \`bash\` to run an equivalent command. Stop this line of work ` +
    `and report what was refused and the reason given.`
  );
}

describe("F-244 real session — hooks.json command hooks on the wire", () => {
  it(
    "F-244/F-030 an exit-2 config hook denies bash in a real session: verbatim denial text, isError, reason from the hook's stderr",
    { timeout: 60_000 },
    async () => {
      // A REAL child process, not an in-process handler: the script is what
      // runCommandHook will spawn (shell: true) when the wired session runs
      // the cfg:preToolUse:0 hook compiled from hooks.json.
      const hookScript = await writeHookScript(
        "deny-bash.sh",
        "#!/bin/sh\nprintf 'bash is not allowed today\\n' >&2\nexit 2\n",
      );
      await writeHooksConfig({
        preToolUse: [{ type: "command", command: hookScript }],
      });

      const { modelPort, requests } = captureModelPort([
        toolCallScript("c1", "bash", JSON.stringify({ command: "echo hi" })),
        textScript("Understood, not running bash."),
      ]);

      // Production assembly ("auto" preset: workspace-write sandbox + no
      // approval), same as timeout-signature-session — the deny happens in
      // the hook pipeline before the executor, but the session around it is
      // the real one.
      const agent = await createWiredAgent({
        modelPort,
        cwd: tempProjectDir,
        permissionMode: "auto",
        sandboxMode: sandboxModeFor("auto"),
        permissionConfig: buildPermissionConfig("auto"),
      });
      let finalStatus: string;
      try {
        const final = await agent.run("run echo hi via bash");
        finalStatus = final.status;
      } finally {
        await agent.dispose();
      }

      // Two scripted model calls: the denied bash round, the text round.
      expect(requests.length).toBe(2);

      // The wire witness: round 2's request carries round 1's denial —
      // the verbatim hook-denial text (reason from the hook's stderr first
      // line, spec D2) AND isError: true, the fail-closed deny shape.
      const round2Block = toolResultBlock(requests[1]!.messages, "c1");
      expect(round2Block, "round 1's denial tool_result must be on the wire").toBeDefined();
      expect(round2Block!.isError).toBe(true);
      const round2Texts = toolResultTexts(requests[1]!.messages, "c1").join("\n");
      expect(round2Texts).toBe(expectedDenialText("bash is not allowed today"));

      // The denial normalized into the feed instead of aborting the turn
      // (AGENTS.md §2.3): the model answered with text and the turn closed.
      expect(finalStatus).toBe("done");
    },
  );

  it(
    "F-244/F-030 an exit-0 config hook lets bash run normally: the tool_result carries real sandboxed output",
    { timeout: 60_000 },
    async () => {
      await writeHooksConfig({
        preToolUse: [{ type: "command", command: "exit 0" }],
      });

      const { modelPort, requests } = captureModelPort([
        toolCallScript("c1", "bash", JSON.stringify({ command: "echo hooks-allow-marker" })),
        textScript("The command ran."),
      ]);

      const agent = await createWiredAgent({
        modelPort,
        cwd: tempProjectDir,
        permissionMode: "auto",
        sandboxMode: sandboxModeFor("auto"),
        permissionConfig: buildPermissionConfig("auto"),
      });
      let finalStatus: string;
      try {
        const final = await agent.run("echo a marker via bash");
        finalStatus = final.status;
      } finally {
        await agent.dispose();
      }

      expect(requests.length).toBe(2);

      // The hook continued (exit 0) and bash executed for real through the
      // sandboxed persistent session — the tool_result on the wire carries
      // the command's actual stdout, and no denial shape.
      const round2Block = toolResultBlock(requests[1]!.messages, "c1");
      expect(round2Block, "round 1's bash tool_result must be on the wire").toBeDefined();
      expect(round2Block!.isError).toBeFalsy();
      const round2Texts = toolResultTexts(requests[1]!.messages, "c1").join("\n");
      expect(round2Texts).toContain("hooks-allow-marker");
      expect(round2Texts).not.toContain("denied by a preToolUse hook");

      expect(finalStatus).toBe("done");
    },
  );
});
