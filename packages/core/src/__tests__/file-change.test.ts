import { describe, it, expect } from "vitest";
import { extractFileChange } from "../file-change.js";
import { buildTurnRecords, toConversationView } from "../view-projection.js";
import type { TranscriptEvent } from "../index.js";

describe("extractFileChange", () => {
  it("reads a well-formed change fact", () => {
    expect(
      extractFileChange({
        path: "a.ts",
        fileChange: {
          path: "a.ts",
          diff: "@@ -1,1 +1,1 @@\n-old\n+new",
          additions: 1,
          deletions: 1,
          truncated: true,
        },
      }),
    ).toEqual({
      path: "a.ts",
      diff: "@@ -1,1 +1,1 @@\n-old\n+new",
      additions: 1,
      deletions: 1,
      truncated: true,
    });
  });

  it("returns null when the metadata carries no change", () => {
    expect(extractFileChange(undefined)).toBeNull();
    expect(extractFileChange({})).toBeNull();
    expect(extractFileChange({ writeFile: { path: "a.ts", mtime: 0 } })).toBeNull();
  });

  it("rejects an empty diff so unchanged writes never reach the UI", () => {
    expect(
      extractFileChange({ fileChange: { path: "a.ts", diff: "", additions: 0, deletions: 0 } }),
    ).toBeNull();
  });

  it("rejects half a change instead of rendering it", () => {
    const base = { path: "a.ts", diff: "@@ -1,1 +1,1 @@", additions: 1, deletions: 1 };
    expect(extractFileChange({ fileChange: { ...base, path: "" } })).toBeNull();
    expect(extractFileChange({ fileChange: { ...base, additions: -1 } })).toBeNull();
    expect(extractFileChange({ fileChange: { ...base, deletions: 1.5 } })).toBeNull();
    expect(extractFileChange({ fileChange: { ...base, diff: undefined } })).toBeNull();
    expect(extractFileChange({ fileChange: "nope" })).toBeNull();
  });
});

function log(entries: Array<Omit<TranscriptEvent, "seq">>): TranscriptEvent[] {
  return entries.map((e, i) => ({ ...e, seq: i }) as TranscriptEvent);
}

describe("toConversationView — file changes", () => {
  const FILE_CHANGE = {
    path: "src/app.ts",
    diff: "@@ -1,1 +1,2 @@\n-old\n+new\n+more",
    additions: 2,
    deletions: 1,
  };

  const LOG = log([
    { time: 100, type: "turn_start", data: { turn: 1 }, turn: 1 },
    { time: 110, type: "user_message", data: { content: "edit it" }, turn: 1 },
    { time: 120, type: "model_call_start", data: { headerHash: "h1" }, turn: 1, step: 1 },
    {
      time: 130,
      type: "assistant_message",
      data: {
        content: [{ type: "tool_use", id: "c1", name: "edit_file", input: { path: "src/app.ts" } }],
        stopReason: "tool_use",
        durationMs: 10,
      },
      turn: 1,
      step: 1,
    },
    {
      time: 140,
      type: "tool_call",
      data: { callId: "c1", name: "edit_file", input: { path: "src/app.ts" } },
      turn: 1,
      step: 1,
    },
    {
      time: 180,
      type: "tool_result",
      data: {
        callId: "c1",
        name: "edit_file",
        content: "edit_file: exact replacement applied in src/app.ts.",
        isError: false,
        orderInBatch: 0,
        displayMetadata: { path: "src/app.ts", fileChange: FILE_CHANGE },
      },
      turn: 1,
      step: 1,
    },
    { time: 210, type: "turn_end", data: { turn: 1, reason: "done" }, turn: 1 },
  ]);

  it("carries the tool's captured change onto the conversation call", () => {
    const view = toConversationView(buildTurnRecords(LOG));
    const call = view.messages
      .flatMap((m) => m.blocks)
      .find((b) => b.type === "tool_call");
    expect(call).toBeDefined();
    if (call?.type !== "tool_call") throw new Error("expected a tool call block");
    expect(call.call.fileChange).toEqual(FILE_CHANGE);
  });

  it("leaves fileChange absent for tools that did not write a file", () => {
    const view = toConversationView(
      buildTurnRecords(
        log([
          { time: 100, type: "turn_start", data: { turn: 1 }, turn: 1 },
          { time: 110, type: "user_message", data: { content: "read it" }, turn: 1 },
          {
            time: 130,
            type: "assistant_message",
            data: {
              content: [{ type: "tool_use", id: "c1", name: "read_file", input: { path: "a.txt" } }],
              stopReason: "tool_use",
              durationMs: 10,
            },
            turn: 1,
            step: 1,
          },
          {
            time: 140,
            type: "tool_call",
            data: { callId: "c1", name: "read_file", input: { path: "a.txt" } },
            turn: 1,
            step: 1,
          },
          {
            time: 180,
            type: "tool_result",
            data: {
              callId: "c1",
              name: "read_file",
              content: "body",
              isError: false,
              orderInBatch: 0,
              displayMetadata: { readFile: { path: "a.txt", mtime: 5 } },
            },
            turn: 1,
            step: 1,
          },
          { time: 210, type: "turn_end", data: { turn: 1, reason: "done" }, turn: 1 },
        ]),
      ),
    );
    const call = view.messages.flatMap((m) => m.blocks).find((b) => b.type === "tool_call");
    if (call?.type !== "tool_call") throw new Error("expected a tool call block");
    expect(call.call.fileChange).toBeUndefined();
  });
});