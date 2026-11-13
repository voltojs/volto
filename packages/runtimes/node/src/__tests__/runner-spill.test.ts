/**
 * Runner spill interception (T5 Task 3) — oversized tool results are
 * intercepted in executeTool BEFORE they reach the reducer: core decides
 * purely (decideSpill), the injected SpillStore persists the full text,
 * and the model sees head + a text reference.
 *
 * Six groups: bash over threshold, git_diff sub-cap interval, web_fetch
 * with untrusted annotation order, exemptions (isError / block array /
 * no config), degradation (failed write never interrupts the loop), and
 * replay consistency.
 */

import { describe, it, expect } from "vitest";
import type {
  EventSink,
  Message,
  Network,
  Shell,
  SpillStore,
  SpillWriteInput,
  StepContext,
  ToolDefinition,
  ToolResult,
  ToolResultBlock,
  ToolResultMessage,
} from "@voltojs/core";
import {
  createMockModelPort,
  toolCallScript,
  textScript,
  renderSpillReference,
  UNTRUSTED_PREFIX,
} from "@voltojs/core";
import { createBashTool, CAP_SHELL_EXEC } from "@voltojs/tools/shell";
import { createGitDiffTool } from "@voltojs/tools/vcs";
import { createWebFetchTool, CAP_NETWORK_FETCH } from "@voltojs/tools/web";
import { createRunner } from "../runner.js";
import { createShellToolExecutor } from "../shell-tool-executor.js";
import { createNetworkToolExecutor } from "../network-tool-executor.js";

const SESSION_ID = "spill-sess";

function fakeStore() {
  const writes: SpillWriteInput[] = [];
  let failNext = false;
  return {
    writes,
    failNext: () => { failNext = true; },
    store: {
      async write(input: SpillWriteInput) {
        if (failNext) { failNext = false; throw new Error("disk full"); }
        writes.push(input);
        return { relativePath: `.volto/spill/${input.sessionId}/${input.toolCallId}.txt` };
      },
    } satisfies SpillStore,
  };
}

function captureEvents(): { events: Array<{ type: string; data: Record<string, unknown> }>; sink: EventSink } {
  const events: Array<{ type: string; data: Record<string, unknown> }> = [];
  return { events, sink: { emit: (e) => { events.push(e); } } };
}

function stdoutShell(data: string, exitCode = 0): Shell {
  return {
    async *exec() {
      yield { type: "stdout", data };
      yield { type: "exit", code: exitCode };
    },
  };
}

function toolMessage(messages: Message[]): ToolResultMessage | undefined {
  return messages.find((m): m is ToolResultMessage => m.role === "tool");
}

/** The tool_result block's first text text, as the reducer stored it. */
function firstToolText(messages: Message[]): string {
  const msg = toolMessage(messages);
  expect(msg).toBeDefined();
  const block = msg!.content[0]!;
  expect(block.content[0]!.type).toBe("text");
  return (block.content[0] as { type: "text"; text: string }).text;
}

// Group 1 fixture: 20_000 chars of stdout, above the 16_000 default threshold.
const BASH_STDOUT = "o".repeat(20_000);
const BASH_TOOL_CALL_ID = "spill-call-1";

async function runBashSpill(spill: { store: SpillStore } | undefined, withEvents = false) {
  const shell = stdoutShell(BASH_STDOUT);
  const bashDef: ToolDefinition = createBashTool(shell).definition;
  const ctx: StepContext = { tools: [bashDef], model: "test" };
  const { events, sink } = captureEvents();
  const model = createMockModelPort([
    toolCallScript(BASH_TOOL_CALL_ID, "bash", '{"command":"cat big.txt"}'),
    textScript("done"),
  ]);
  const runner = createRunner({
    modelPort: model,
    stepContext: ctx,
    availableCapabilities: new Set([CAP_SHELL_EXEC]),
    toolExecutor: createShellToolExecutor({ shell }),
    sessionId: SESSION_ID,
    ...(spill ? { spill } : {}),
    ...(withEvents ? { eventSink: sink } : {}),
  });
  const final = await runner.run({ type: "user_message", content: "run it" });
  return { final, events };
}

describe("Runner tool-result spill interception", () => {
  it("F-183 bash over threshold: model sees head + reference, store gets the full text", async () => {
    const { store, writes } = fakeStore();
    const { final, events } = await runBashSpill({ store }, true);

    expect(final.status).toBe("done");

    // The reference is rendered by core's renderSpillReference, verbatim,
    // with the deterministic path the fake store returned.
    const expectedText =
      "o".repeat(2_000) +
      renderSpillReference({
        relativePath: `.volto/spill/${SESSION_ID}/${BASH_TOOL_CALL_ID}.txt`,
        totalChars: 20_000,
      });
    expect(firstToolText(final.messages)).toBe(expectedText);

    // displayMetadata rides the tool_result event (not the state message).
    // The recorder's streamed twin names the id `callId` (transcript shape).
    const resultEvent = events.find(
      (e) => e.type === "tool_result" && (e.data as { callId?: string }).callId === BASH_TOOL_CALL_ID,
    );
    expect(resultEvent).toBeDefined();
    expect(resultEvent!.data.displayMetadata).toMatchObject({
      spilled: true,
      spillPath: `.volto/spill/${SESSION_ID}/${BASH_TOOL_CALL_ID}.txt`,
      totalChars: 20_000,
    });

    // The store received the ORIGINAL full text, verbatim.
    expect(writes).toHaveLength(1);
    expect(writes[0]!.sessionId).toBe(SESSION_ID);
    expect(writes[0]!.toolCallId).toBe(BASH_TOOL_CALL_ID);
    expect(writes[0]!.text).toBe(BASH_STDOUT);
  });

  it("F-183 git_diff inside its own 20_000 tool cap: 18_000 chars still spills with totalChars 18_000", async () => {
    // 18_000 < git_diff's 20_000 cap, so the tool does NOT truncate —
    // the Runner's 16_000 spill threshold is what fires (Review Focus 5).
    const DIFF_STDOUT = "d".repeat(18_000);
    const toolCallId = "spill-diff";
    const shell = stdoutShell(DIFF_STDOUT);
    const gitDiffTool = createGitDiffTool(shell);
    const ctx: StepContext = { tools: [gitDiffTool.definition], model: "test" };
    const { store, writes } = fakeStore();
    const model = createMockModelPort([
      toolCallScript(toolCallId, "git_diff", "{}"),
      textScript("done"),
    ]);
    const runner = createRunner({
      modelPort: model,
      stepContext: ctx,
      availableCapabilities: new Set([CAP_SHELL_EXEC]),
      toolExecutor: async (call) => gitDiffTool.handler(call.input),
      sessionId: SESSION_ID,
      spill: { store },
    });
    const final = await runner.run({ type: "user_message", content: "diff" });

    expect(final.status).toBe("done");
    const expectedText =
      "d".repeat(2_000) +
      renderSpillReference({
        relativePath: `.volto/spill/${SESSION_ID}/${toolCallId}.txt`,
        totalChars: 18_000,
      });
    expect(firstToolText(final.messages)).toBe(expectedText);
    expect(writes[0]!.text).toBe(DIFF_STDOUT);
  });

  it("F-183 web_fetch: spill happens before the untrusted annotation, reference survives", async () => {
    // web_fetch is trust:"untrusted" — the Runner annotates in the feed
    // loop AFTER executeTool, so the annotation wraps head + reference
    // (Review Focus 4). The store must get the RAW body, no prefix.
    const BODY = "b".repeat(20_000);
    const toolCallId = "spill-fetch";
    const network: Network = {
      async fetch() {
        return { status: 200, headers: {}, body: BODY };
      },
    };
    const webFetchDef: ToolDefinition = createWebFetchTool(network).definition;
    const ctx: StepContext = { tools: [webFetchDef], model: "test" };
    const { store, writes } = fakeStore();
    const model = createMockModelPort([
      toolCallScript(toolCallId, "web_fetch", '{"url":"https://example.com/page"}'),
      textScript("done"),
    ]);
    const runner = createRunner({
      modelPort: model,
      stepContext: ctx,
      availableCapabilities: new Set([CAP_NETWORK_FETCH]),
      toolExecutor: createNetworkToolExecutor({ network }),
      sessionId: SESSION_ID,
      spill: { store },
    });
    const final = await runner.run({ type: "user_message", content: "fetch it" });

    expect(final.status).toBe("done");
    const text = firstToolText(final.messages);
    // Annotation first (feed loop), then the spilled head, then the reference.
    expect(text.startsWith(UNTRUSTED_PREFIX)).toBe(true);
    const unannotated = text.slice(UNTRUSTED_PREFIX.length);
    expect(unannotated.startsWith("b".repeat(2_000))).toBe(true);
    expect(unannotated).toContain("full output saved to");
    expect(unannotated.endsWith(
      renderSpillReference({
        relativePath: `.volto/spill/${SESSION_ID}/${toolCallId}.txt`,
        totalChars: 20_000,
      }),
    )).toBe(true);
    // The spill captured the raw body BEFORE annotation.
    expect(writes[0]!.text).toBe(BODY);
  });

  it("F-183 exemptions: isError, block-array modelContent, and missing spill config all pass through untouched", async () => {
    const EXEMPT_TOOL_CALL_ID = "spill-exempt";
    const exemptDef: ToolDefinition = {
      name: "blob",
      description: "Returns oversized output",
      inputSchema: { type: "object", properties: {} },
      requires: ["filesystem:read"],
      riskTier: "READ_ONLY",
    };
    const ctx: StepContext = { tools: [exemptDef], model: "test" };
    const caps = new Set(["filesystem:read"]);

    // (a) isError results pass through untouched — no spill, no write.
    const ERROR_TEXT = "e".repeat(20_000);
    const { store: errorStore, writes: errorWrites } = fakeStore();
    const errorModel = createMockModelPort([
      toolCallScript(EXEMPT_TOOL_CALL_ID, "blob", "{}"),
      textScript("done"),
    ]);
    const errorRunner = createRunner({
      modelPort: errorModel,
      stepContext: ctx,
      availableCapabilities: caps,
      toolExecutor: async (): Promise<ToolResult> => ({ modelContent: ERROR_TEXT, isError: true }),
      sessionId: SESSION_ID,
      spill: { store: errorStore },
    });
    const errorFinal = await errorRunner.run({ type: "user_message", content: "go" });
    expect(errorWrites).toHaveLength(0);
    expect(firstToolText(errorFinal.messages)).toBe(ERROR_TEXT);

    // (b) block-array modelContent (with an image ref) passes through untouched.
    const BLOCK_TEXT = "t".repeat(20_000);
    const blocks: ToolResultBlock[] = [
      { type: "text", text: BLOCK_TEXT },
      { type: "image", source: { type: "ref", id: "att-1", mediaType: "image/png" } },
    ];
    const { store: blockStore, writes: blockWrites } = fakeStore();
    const blockModel = createMockModelPort([
      toolCallScript(EXEMPT_TOOL_CALL_ID, "blob", "{}"),
      textScript("done"),
    ]);
    const blockRunner = createRunner({
      modelPort: blockModel,
      stepContext: ctx,
      availableCapabilities: caps,
      toolExecutor: async (): Promise<ToolResult> => ({ modelContent: blocks }),
      sessionId: SESSION_ID,
      spill: { store: blockStore },
    });
    const blockFinal = await blockRunner.run({ type: "user_message", content: "go" });
    expect(blockWrites).toHaveLength(0);
    const blockMsg = toolMessage(blockFinal.messages);
    expect(blockMsg).toBeDefined();
    expect(blockMsg!.content[0]!.content).toEqual(blocks);

    // (c) missing spill config → zero behavior change (tool's own status
    // quo: bash does not truncate 20_000 chars under its 100_000 limit),
    // and the store the host holds is never written to.
    const { writes: plainWrites } = fakeStore();
    const { final: plainFinal } = await runBashSpill(undefined);
    expect(plainWrites).toHaveLength(0);
    expect(firstToolText(plainFinal.messages)).toBe(BASH_STDOUT);
  });

  it("F-183 degradation: a failed store write passes the result through and emits spill_failed without breaking the loop", async () => {
    const { store, failNext } = fakeStore();
    failNext();
    const { final, events } = await runBashSpill({ store }, true);

    // Loop not interrupted: the turn still completes.
    expect(final.status).toBe("done");
    // Result passed through COMPLETE and untouched.
    expect(firstToolText(final.messages)).toBe(BASH_STDOUT);
    // spill_failed was emitted with the toolCallId and the error message.
    const failure = events.find((e) => e.type === "spill_failed");
    expect(failure).toBeDefined();
    expect(failure!.data.toolCallId).toBe(BASH_TOOL_CALL_ID);
    expect(failure!.data.error).toBe("disk full");
  });

  it("F-185 replay: two runs of the same script produce identical messages, writes, and references", async () => {
    const runOnce = async () => {
      const { store, writes } = fakeStore();
      const { final } = await runBashSpill({ store });
      return { final, writes };
    };

    const first = await runOnce();
    const second = await runOnce();

    // Same script + same spill decisions → deep-equal transcripts.
    expect(first.final.messages).toEqual(second.final.messages);
    // Store writes are verbatim identical (sessionId / toolCallId / text).
    expect(first.writes).toEqual(second.writes);
    expect(first.writes[0]!.text).toBe(BASH_STDOUT);
    // The rendered reference text is verbatim identical across runs.
    expect(firstToolText(first.final.messages)).toBe(firstToolText(second.final.messages));
  });
});
