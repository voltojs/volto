import { describe, it, expect } from "vitest";
import type {
  EventSink,
  FileSystem,
  FileReadResult,
  FileStat,
  StepContext,
  ToolDefinition,
  TranscriptEvent,
} from "@volto/core";
import {
  buildTurnRecords,
  createMockModelPort,
  modelDone,
  textDelta,
  toConversationView,
  toolUseDelta,
  toolUseStart,
} from "@volto/core";
import { createReadFileTool, createEditFileTool, CAP_FS_READ, CAP_FS_WRITE } from "@volto/tools-fs";
import { createRunner } from "../runner.js";
import { createFsToolExecutor } from "../tool-executor.js";

function createInMemoryFs(seed: Record<string, string>): { fs: FileSystem; get: (p: string) => string | undefined } {
  const store = new Map(Object.entries(seed));
  const mtimes = new Map<string, number>(Object.keys(seed).map((k) => [k, 100]));
  let clock = 100;
  const fs: FileSystem = {
    async read(target, offset = 1, limit?): Promise<FileReadResult> {
      const content = store.get(target);
      if (content === undefined) throw new Error(`ENOENT: ${target}`);
      const lines = content.split(/\r?\n/);
      const sliced = limit ? lines.slice(offset - 1, offset - 1 + limit) : lines.slice(offset - 1);
      return { content: sliced.join("\n"), totalLines: lines.length, truncated: false };
    },
    async readBytes(): Promise<never> {
      throw new Error("readBytes is not implemented in this test double");
    },
    async write(target, data): Promise<void> { store.set(target, data); mtimes.set(target, ++clock); },
    async stat(target): Promise<FileStat> {
      if (!store.has(target)) throw new Error(`ENOENT: ${target}`);
      return { path: target, isDirectory: false, size: 0, mtime: mtimes.get(target) ?? 0 };
    },
    async list() { return { entries: [] }; },
    async glob() { return { paths: [] }; },
    async grep() { return { matches: [], truncated: false }; },
  };
  return { fs, get: (p) => store.get(p) };
}

const fsTools: ToolDefinition[] = [
  createReadFileTool({} as FileSystem).definition,
  createEditFileTool({} as FileSystem).definition,
];
const ctx: StepContext = { tools: fsTools, model: "test" };
const caps = new Set([CAP_FS_READ, CAP_FS_WRITE]);

describe("fs end-to-end via Runner (reducer recording + executor gate)", () => {
  it("AC4: read_file then edit_file succeeds and writes the change", async () => {
    const { fs, get } = createInMemoryFs({ "foo.ts": "const x = 1;" });
    const model = createMockModelPort([
      [toolUseStart("c1", "read_file"), toolUseDelta("c1", '{"path":"foo.ts"}'), modelDone("tool_use")],
      [toolUseStart("c2", "edit_file"), toolUseDelta("c2", '{"path":"foo.ts","old_string":"const x = 1;","new_string":"const x = 2;"}'), modelDone("tool_use")],
      [textDelta("Done."), modelDone("end_turn")],
    ]);

    const runner = createRunner({
      modelPort: model,
      stepContext: ctx,
      availableCapabilities: caps,
      toolExecutor: createFsToolExecutor({ fs }),
    });

    const final = await runner.run({ type: "user_message", content: "bump x to 2" });
    expect(final.status).toBe("done");
    expect(get("foo.ts")).toBe("const x = 2;");
    // The read was recorded into serializable state.
    expect(final.readFiles.find((r) => r.path === "foo.ts")).toBeDefined();
  });

  it("AC3: edit_file without a prior read is rejected and the file is untouched", async () => {
    const { fs, get } = createInMemoryFs({ "bar.ts": "const x = 1;" });
    const model = createMockModelPort([
      [toolUseStart("c1", "edit_file"), toolUseDelta("c1", '{"path":"bar.ts","old_string":"const x = 1;","new_string":"HACKED"}'), modelDone("tool_use")],
      [textDelta("Could not edit."), modelDone("end_turn")],
    ]);

    const runner = createRunner({
      modelPort: model,
      stepContext: ctx,
      availableCapabilities: caps,
      toolExecutor: createFsToolExecutor({ fs }),
    });

    const final = await runner.run({ type: "user_message", content: "edit without reading" });
    expect(final.status).toBe("done");
    expect(get("bar.ts")).toBe("const x = 1;"); // unchanged — gate ran before write
    const toolMsg = final.messages.find((m) => m.role === "tool");
    expect(toolMsg?.content[0]).toMatchObject({ isError: true });
  });

  it("records the edit's diff in the transcript and projects it onto the conversation call", async () => {
    const { fs } = createInMemoryFs({ "foo.ts": "const x = 1;\nconst y = 0;" });
    const model = createMockModelPort([
      [toolUseStart("c1", "read_file"), toolUseDelta("c1", '{"path":"foo.ts"}'), modelDone("tool_use")],
      [
        toolUseStart("c2", "edit_file"),
        toolUseDelta("c2", '{"path":"foo.ts","old_string":"const x = 1;","new_string":"const x = 2;"}'),
        modelDone("tool_use"),
      ],
      [textDelta("Done."), modelDone("end_turn")],
    ]);
    const recorded: Array<{ type: string; data: Record<string, unknown>; time: number; turn?: number; step?: number }> = [];
    const eventSink: EventSink = {
      emit: (event) => {
        recorded.push(event as (typeof recorded)[number]);
      },
    };

    const runner = createRunner({
      modelPort: model,
      stepContext: ctx,
      availableCapabilities: caps,
      toolExecutor: createFsToolExecutor({ fs }),
      eventSink,
    });
    await runner.run({ type: "user_message", content: "bump x" });

    // Only the stamped events are transcript records; the sink also carries
    // untimed observability residuals.
    const events = recorded
      .filter((event) => typeof event.time === "number")
      .map((event, seq) => ({ ...event, seq }) as unknown as TranscriptEvent);
    expect(events.length).toBeGreaterThan(0);

    const changed = events.find(
      (event) => event.type === "tool_result" && (event.data as { callId?: string }).callId === "c2",
    );
    expect(changed).toBeDefined();
    const metadata = (changed!.data as { displayMetadata?: Record<string, unknown> }).displayMetadata;
    expect(metadata?.["fileChange"]).toMatchObject({ path: "foo.ts", additions: 1, deletions: 1 });

    const view = toConversationView(buildTurnRecords(events));
    const call = view.messages
      .flatMap((message) => message.blocks)
      .find((block) => block.type === "tool_call" && block.call.id === "c2");
    if (call?.type !== "tool_call") throw new Error("expected the edit call in the view");
    expect(call.call.fileChange).toMatchObject({ path: "foo.ts", additions: 1, deletions: 1 });
    expect(call.call.fileChange?.diff).toContain("-const x = 1;");
    expect(call.call.fileChange?.diff).toContain("+const x = 2;");
  });
});
