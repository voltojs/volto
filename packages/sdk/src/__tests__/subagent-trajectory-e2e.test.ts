import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createAgent } from "../create-agent.js";
import { buildTurnRecords, toTrajectoryView } from "@volto/core";
import type { EventSink, ModelEvent, ModelPort, ModelRequest, TrajectoryRow } from "@volto/core";
import { createStore, scopeToWorkspace } from "@volto/store-jsonl";
import type { ChatSessionRecord } from "@volto/store-jsonl";
import type { AgentEntry } from "../agent-registry/scan.js";
import { modelDone, textScript, toolUseDelta, toolUseStart } from "@volto/core";

let directory: string;

beforeEach(async () => {
  directory = await mkdtemp(path.join(tmpdir(), "volto-trajectory-e2e-"));
});

afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});

function routedPort(opts: {
  children: Readonly<Record<string, ModelEvent[]>>;
  main: Array<() => ModelEvent[]>;
}): ModelPort {
  let mainIndex = 0;
  return {
    async *stream(req: ModelRequest) {
      const users = req.messages.filter((message) => message.role === "user");
      const last = users[users.length - 1];
      const text = typeof last?.content === "string" ? last.content : "";
      const child = opts.children[text];
      if (child !== undefined) {
        yield* child;
        return;
      }
      const next = opts.main[mainIndex];
      mainIndex++;
      if (next === undefined) throw new Error(`no main script for call ${mainIndex - 1}`);
      yield* next();
    },
  };
}

function taskCall(id: string, args: Record<string, unknown>): ModelEvent[] {
  return [
    toolUseStart(id, "task"),
    toolUseDelta(id, JSON.stringify(args)),
    modelDone("tool_use"),
  ];
}

function rowsFor(record: ChatSessionRecord | undefined): TrajectoryRow[] {
  if (record === undefined) return [];
  return toTrajectoryView(buildTurnRecords(record.events), record.events).rows;
}

const EXPLORE: AgentEntry = {
  id: "plugin:explore",
  scope: "plugin",
  shadowed: false,
  spec: { name: "explore", description: "Explore a subsystem" },
};

describe("subagent trajectory e2e", () => {
  it("links a typed sync dispatch and attributes the child's first task", async () => {
    const store = createStore({ directory });
    const agent = createAgent({
      modelPort: routedPort({
        children: { "child work": textScript("child done") },
        main: [
          () => taskCall("c1", { message: "child work", subagent_type: "explore" }),
          () => textScript("parent done"),
        ],
      }),
      chatStore: scopeToWorkspace(store, directory),
      chatSessionId: "parent-1",
      chatMeta: { projectId: null, providerId: null, modelId: null, permissionMode: null },
      enableTaskTool: true,
      agentSpecs: [EXPLORE],
    });

    await agent.run("go");

    const parent = rowsFor(await store.readSession("parent-1"));
    const subagent = parent.find((row) => row.kind === "subagent");
    expect(subagent).toBeDefined();
    expect(subagent).toMatchObject({
      taskId: expect.any(String),
      childSessionId: expect.any(String),
      subagentType: "explore",
    });
    const child = rowsFor(await store.readSession(String(subagent!.childSessionId)));
    expect(child.find((row) => row.kind === "user")?.messageSource).toMatchObject({
      kind: "subagent-task",
      parentSessionId: "parent-1",
      taskId: subagent!.taskId,
    });
  });

  it("links a background completion to its child session", async () => {
    const store = createStore({ directory });
    const agent = createAgent({
      modelPort: routedPort({
        children: { "background work": textScript("child done") },
        main: [
          () => taskCall("c1", { message: "background work", run_in_background: true }),
          () => textScript("parent done"),
        ],
      }),
      chatStore: scopeToWorkspace(store, directory),
      chatSessionId: "parent-1",
      chatMeta: { projectId: null, providerId: null, modelId: null, permissionMode: null },
      enableTaskTool: true,
    });

    await agent.run("go");
    await vi.waitFor(async () => {
      const rows = rowsFor(await store.readSession("parent-1"));
      expect(rows.some((row) => row.kind === "reminder")).toBe(true);
    });

    const rows = rowsFor(await store.readSession("parent-1"));
    const subagent = rows.find((row) => row.kind === "subagent")!;
    const reminder = rows.find(
      (row) => row.kind === "reminder" && row.reminderKind === "background_task",
    )!;
    expect(subagent.background).toBe(true);
    expect(reminder.childSessionId).toBe(subagent.childSessionId);
    expect(reminder.taskId).toBe(subagent.taskId);
  });

  it("links a task_output row to the collected child without upgrading it", async () => {
    const store = createStore({ directory });
    let capturedTaskId = "";
    const eventSink: EventSink = {
      emit(event) {
        if (event.type === "subagent_started" && typeof event.data["taskId"] === "string") {
          capturedTaskId = event.data["taskId"];
        }
      },
    };
    const agent = createAgent({
      modelPort: routedPort({
        children: { "collected work": textScript("child done") },
        main: [
          () => taskCall("c1", { message: "collected work", run_in_background: true }),
          () => [
            toolUseStart("c2", "task_output"),
            toolUseDelta("c2", JSON.stringify({ task_id: capturedTaskId })),
            modelDone("tool_use"),
          ],
          () => textScript("done"),
        ],
      }),
      eventSink,
      chatStore: scopeToWorkspace(store, directory),
      chatSessionId: "parent-1",
      chatMeta: { projectId: null, providerId: null, modelId: null, permissionMode: null },
      enableTaskTool: true,
    });

    await agent.run("go");

    const rows = rowsFor(await store.readSession("parent-1"));
    const subagent = rows.find((row) => row.kind === "subagent")!;
    const output = rows.find(
      (row) => row.kind === "tool" && row.taskId === subagent.taskId,
    );
    expect(output?.relatedSessionId).toBe(subagent.childSessionId);
    expect(output?.childSessionId).toBeUndefined();
  });

  it("keeps two parallel dispatches on their own child rows", async () => {
    const store = createStore({ directory });
    const agent = createAgent({
      modelPort: routedPort({
        children: { "child A": textScript("A done"), "child B": textScript("B done") },
        main: [
          () => [
            toolUseStart("c1", "task"),
            toolUseDelta("c1", JSON.stringify({ message: "child A" })),
            toolUseStart("c2", "task"),
            toolUseDelta("c2", JSON.stringify({ message: "child B" })),
            modelDone("tool_use"),
          ],
          () => textScript("parent done"),
        ],
      }),
      chatStore: scopeToWorkspace(store, directory),
      chatSessionId: "parent-1",
      chatMeta: { projectId: null, providerId: null, modelId: null, permissionMode: null },
      enableTaskTool: true,
    });

    await agent.run("go");
    await vi.waitFor(async () => {
      const rows = rowsFor(await store.readSession("parent-1"));
      expect(rows.filter((row) => row.kind === "subagent")).toHaveLength(2);
    });

    const rows = rowsFor(await store.readSession("parent-1"));
    const subagents = rows.filter((row) => row.kind === "subagent");
    expect(new Set(subagents.map((row) => row.childSessionId)).size).toBe(2);
    expect(new Set(subagents.map((row) => row.taskId)).size).toBe(2);
  });
});
