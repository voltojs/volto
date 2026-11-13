import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
  createMockModelPort,
  textScript,
  toolCallScript,
} from "@voltojs/core";
import type { ModelEvent, ModelPort, ModelRequest } from "@voltojs/core";
import type { AgentSpec } from "@voltojs/sdk";
import { createWiredAgent } from "../wiring.js";

/**
 * F-152 — the T2 acceptance core: a REAL gateway session, built through the
 * production wiring (`createWiredAgent`, which hardwires `enableTaskTool:
 * true` and injects the scanned agent definitions), dispatches a sub-agent
 * and the assertions land on the ModelRequests the model actually received.
 *
 * Nothing in the dispatch path is stubbed: the same task tool, executor,
 * registry and envelope assembly a production session runs are exercised; only
 * the ModelPort is scripted, exactly as in lsp-db-session.test.ts.
 */

/** One typed sub-agent definition, injected the way a plugin agent arrives. */
const TYPED_SPEC: AgentSpec = {
  name: "e2e-typed",
  description: "Typed sub-agent for the gateway session acceptance",
};

/** Parent chat session id: the child id is derived as `<parent>-sub-<n>`. */
const PARENT_SESSION_ID = "e2e-parent";

let tempConfigDir: string;
let tempProjectDir: string;
let tempHomeDir: string;
let originalConfigDir: string | undefined;
let originalHome: string | undefined;

beforeEach(async () => {
  tempConfigDir = await fs.mkdtemp(path.join(os.tmpdir(), "volto-subagent-session-config-"));
  tempProjectDir = await fs.mkdtemp(path.join(os.tmpdir(), "volto-subagent-session-project-"));
  tempHomeDir = await fs.mkdtemp(path.join(os.tmpdir(), "volto-subagent-session-home-"));
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

/** Wrap a scripted mock port so every ModelRequest the session makes is captured. */
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

/**
 * Content-routed capture port: the sub-agent's request carries its dispatch
 * message as the latest user message, the parent's never does. Routing on
 * content (not call order) keeps the test deterministic while a detached
 * background sub-agent's model call races the parent's next one.
 */
function routedCapturePort(opts: {
  subMessage: string;
  subScript: ModelEvent[];
  mainScripts: Array<(req: ModelRequest) => ModelEvent[]>;
}): { modelPort: ModelPort; mainRequests: ModelRequest[] } {
  const mainRequests: ModelRequest[] = [];
  let mainIndex = 0;
  return {
    mainRequests,
    modelPort: {
      async *stream(req) {
        const users = req.messages.filter((m) => m.role === "user");
        const lastUser = users[users.length - 1];
        const lastUserText = typeof lastUser?.content === "string" ? lastUser.content : "";
        if (lastUserText === opts.subMessage) {
          yield* opts.subScript;
          return;
        }
        mainRequests.push(req);
        const step = opts.mainScripts[mainIndex];
        mainIndex++;
        if (!step) throw new Error(`no main script for call ${mainIndex - 1}`);
        yield* step(req);
      },
    },
  };
}

/**
 * The text blocks of the tool_result for `toolUseId` in `request` — the exact
 * block array the provider-bound request carries. Throws when the tool result
 * is missing: an absent result must fail loudly, never pass as empty output.
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

/** Extracts the task id the task tool embedded in the dispatch tool_result. */
function extractTaskId(request: ModelRequest): string {
  for (const text of toolResultTextBlocks(request, "c1")) {
    const match = /task_id="([^"]+)"/.exec(text);
    if (match?.[1]) return match[1];
  }
  throw new Error("no task_id in the dispatch tool_result");
}

/** Build a real session the way sessions.ts does, plus the typed definition. */
async function buildWiredSession(modelPort: ModelPort) {
  return createWiredAgent({
    modelPort,
    cwd: tempProjectDir,
    chatSessionId: PARENT_SESSION_ID,
    pluginAgents: [TYPED_SPEC],
  });
}

describe("T2 real session — sub-agent envelope and per-dispatch model override", () => {
  it("F-152 the parent model receives the envelope as a second text block", async () => {
    const { modelPort, requests } = captureModelPort([
      toolCallScript(
        "c1",
        "task",
        JSON.stringify({ message: "summarize the release notes", subagent_type: "e2e-typed" }),
      ),
      textScript("child body summary"),
      textScript("all done"),
    ]);
    const agent = await buildWiredSession(modelPort);
    try {
      await agent.run("dispatch the typed sub-agent");

      // Request 0 = parent turn 1, request 1 = sub-agent, request 2 = parent
      // folding the tool_result in.
      expect(requests.length).toBe(3);
      const blocks = toolResultTextBlocks(requests[2]!, "c1");
      // Exactly two text blocks: child body, then the bare JSON envelope.
      expect(blocks).toEqual(["child body summary", expect.any(String)]);

      const envelope = JSON.parse(blocks[1]!) as Record<string, unknown>;
      expect(envelope["status"]).toBe("completed");
      // The child hangs off the real parent session: "<parent>-sub-<n>".
      expect(String(envelope["childSessionId"])).toMatch(
        new RegExp(`^${PARENT_SESSION_ID}-sub-`),
      );
    } finally {
      await agent.dispose();
    }
  });

  it("F-152 a per-dispatch model override reaches the child's ModelRequest", async () => {
    const { modelPort, requests } = captureModelPort([
      toolCallScript(
        "c1",
        "task",
        JSON.stringify({
          message: "quick pass",
          subagent_type: "e2e-typed",
          model: "e2e-cheap-model",
        }),
      ),
      textScript("child done"),
      textScript("all done"),
    ]);
    const agent = await buildWiredSession(modelPort);
    try {
      await agent.run("dispatch with a cheaper model for this task only");

      // Request 1 is the sub-agent's own model call — the override lands
      // verbatim, while the parent's request keeps the session model.
      expect(requests.length).toBe(3);
      expect(requests[1]!.model).toBe("e2e-cheap-model");
      expect(requests[0]!.model).not.toBe("e2e-cheap-model");
    } finally {
      await agent.dispose();
    }
  });

  it("F-152 task_output returns the same envelope in a real session", async () => {
    const SUB_MSG = "long e2e background scan";
    let collectedTaskId = "";
    const { modelPort, mainRequests } = routedCapturePort({
      subMessage: SUB_MSG,
      subScript: textScript("background child body", 7, 3),
      mainScripts: [
        () =>
          toolCallScript(
            "c1",
            "task",
            JSON.stringify({
              message: SUB_MSG,
              subagent_type: "e2e-typed",
              run_in_background: true,
            }),
          ),
        (req) => {
          collectedTaskId = extractTaskId(req);
          return toolCallScript("c2", "task_output", JSON.stringify({ task_id: collectedTaskId }));
        },
        () => textScript("collected."),
      ],
    });
    const agent = await buildWiredSession(modelPort);
    try {
      await agent.run("start a background scan, then collect it");

      // Background dispatch itself hands back only the task id — never the
      // result text, never an envelope.
      const dispatchBlocks = toolResultTextBlocks(mainRequests[1]!, "c1");
      expect(dispatchBlocks).toHaveLength(1);
      expect(dispatchBlocks[0]).toContain("started in background");
      expect(dispatchBlocks[0]).toContain(`task_id="${collectedTaskId}"`);

      // task_output recovers the full outcome: the same two-block shape the
      // sync path returns, with childSessionId and summed usage.
      const blocks = toolResultTextBlocks(mainRequests[2]!, "c2");
      expect(blocks).toEqual(["background child body", expect.any(String)]);
      const envelope = JSON.parse(blocks[1]!) as Record<string, unknown>;
      expect(envelope["status"]).toBe("completed");
      expect(String(envelope["childSessionId"])).toMatch(
        new RegExp(`^${PARENT_SESSION_ID}-sub-`),
      );
      expect(envelope["usage"]).toEqual({ inputTokens: 7, outputTokens: 3 });
    } finally {
      await agent.dispose();
    }
  });
});
