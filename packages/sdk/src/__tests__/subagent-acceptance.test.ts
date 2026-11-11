import { describe, it, expect } from "vitest";
import { createAgent } from "../create-agent.js";
import type { CreateAgentOptions, AgentInstance } from "../create-agent.js";
import { textScript, toolCallScript, modelError } from "@volto/core";
import type {
  ModelPort,
  ModelRequest,
  ModelEvent,
  TranscriptEventInput,
  ToolResultMessage,
  DispatchVerification,
} from "@volto/core";

// ──────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────

// Copied from transcript-orchestration.test.ts: an in-memory TranscriptStore
// that keeps every appended batch addressable by session id.
function fakeChatStore() {
  const bySession = new Map<string, TranscriptEventInput[]>();
  return {
    bySession,
    store: {
      async appendEvents(sessionId: string, events: TranscriptEventInput[]) {
        const list = bySession.get(sessionId) ?? [];
        list.push(...events);
        bySession.set(sessionId, list);
      },
    },
  };
}

// Route scripts by request content, avoiding parent / child / verifier call
// order races.
type Kind = "parent" | "child" | "verifier";
function routedPort(scripts: Record<Kind, ModelEvent[][]>) {
  const idx: Record<Kind, number> = { parent: 0, child: 0, verifier: 0 };
  const counts: Record<Kind, number> = { parent: 0, child: 0, verifier: 0 };
  return {
    counts,
    async *stream(req: ModelRequest) {
      const kind: Kind =
        req.responseFormat?.type === "json" ? "verifier"
        : req.messages.some((m) => m.role === "system") ? "child"
        : "parent";
      counts[kind] += 1;
      const events = scripts[kind][idx[kind]++]!;
      for (const event of events) yield event;
    },
  } as ModelPort & { counts: typeof counts };
}
// A sub-agent request always carries a system message; the test parent passes
// no systemPrompt; a verifier request always carries responseFormat.

// Deterministic per-instance id counter (fresh on every call, so two runs
// produce identical ids — the replay assertion's premise).
function makeAgent(port: ModelPort, overrides: Partial<CreateAgentOptions> = {}) {
  let n = 0;
  const chat = fakeChatStore();
  const agent = createAgent({
    modelPort: port,
    enableTaskTool: true,
    chatStore: chat.store,
    chatSessionId: "p",
    id: { next: () => `id-${++n}` },
    ...overrides,
  });
  return { agent, store: chat };
}

/** The last role:"tool" message in the parent's settled state. */
function lastToolResult(agent: AgentInstance): ToolResultMessage {
  const messages = agent.getState().messages;
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i]!;
    if (message.role === "tool") return message;
  }
  throw new Error("no tool result message in agent state");
}

/** Parse the JSON envelope — the second text block of the tool result. */
function envelope(msg: ToolResultMessage): Record<string, unknown> {
  const block = msg.content[0]!;
  const second = block.content[1]!;
  if (second.type !== "text") throw new Error("envelope block is not text");
  return JSON.parse(second.text) as Record<string, unknown>;
}

/** Narrow a session log to its user_message records (typed data access). */
function userMessagesOf(events: TranscriptEventInput[]): TranscriptEventInput<"user_message">[] {
  return events.filter((e): e is TranscriptEventInput<"user_message"> => e.type === "user_message");
}

/** The one child session this dispatch wrote ("p-sub-…"). */
function childLog(store: ReturnType<typeof fakeChatStore>): TranscriptEventInput[] {
  // bySession is a Map, so enumerate its keys (Object.keys would see none).
  const childId = [...store.bySession.keys()].find((k) => k.startsWith("p-sub-"))!;
  return store.bySession.get(childId)!;
}

const DISPATCH_WITH_ACCEPTANCE = toolCallScript(
  "c1",
  "task",
  JSON.stringify({ message: "do it", acceptance: "tests pass" }),
);

// ──────────────────────────────────────────────
// Acceptance verification on sync dispatch
// ──────────────────────────────────────────────

describe("subagent acceptance verification", () => {
  it("passes on the first attempt and shows the criteria to the child", async () => {
    const port = routedPort({
      parent: [DISPATCH_WITH_ACCEPTANCE, textScript("parent done")],
      child: [textScript("child output")],
      verifier: [textScript('{"passed":true,"failures":[]}')],
    });
    const { agent, store } = makeAgent(port);
    for await (const _ of agent.stream("start")) { /* drain */ }
    const child = childLog(store);
    expect(userMessagesOf(child)[0]!.data.content).toContain("tests pass");
    expect(port.counts).toEqual({ parent: 2, child: 1, verifier: 1 });
    expect(envelope(lastToolResult(agent))["verification"]).toMatchObject({ status: "passed", attempts: 1 });
  });

  it("reworks a failed attempt and passes on the second", async () => {
    const port = routedPort({
      parent: [DISPATCH_WITH_ACCEPTANCE, textScript("parent done")],
      child: [textScript("v1"), textScript("v2")],
      verifier: [
        textScript('{"passed":false,"failures":["no tests"],"retry_hint":"run pnpm test"}'),
        textScript('{"passed":true,"failures":[]}'),
      ],
    });
    const { agent, store } = makeAgent(port);
    for await (const _ of agent.stream("start")) { /* drain */ }
    const child = childLog(store);
    // The child session holds exactly turn 0 and turn 1.
    const turns = [...new Set(child.filter((e) => e.turn !== undefined).map((e) => e.turn))].sort();
    expect(turns).toEqual([0, 1]);
    const users = userMessagesOf(child);
    expect(users).toHaveLength(2);
    expect(users[0]!.turn).toBe(0);
    expect(users[1]!.turn).toBe(1);
    const rework = users[1]!.data.content as string;
    expect(rework).toContain("tests pass");
    expect(rework).toContain("no tests");
    expect(rework).toContain("run pnpm test");
    // Same subagent-task provenance (same taskId) as the opening message.
    expect(users[1]!.data.source).toEqual(users[0]!.data.source);
    expect(envelope(lastToolResult(agent))["verification"]).toMatchObject({ status: "passed", attempts: 2 });
    expect(port.counts).toEqual({ parent: 2, child: 2, verifier: 2 });
  });

  it("marks an exhausted dispatch as an error", async () => {
    const port = routedPort({
      parent: [DISPATCH_WITH_ACCEPTANCE, textScript("parent done")],
      child: [textScript("v1"), textScript("v2")],
      verifier: [
        textScript('{"passed":false,"failures":["no tests"]}'),
        textScript('{"passed":false,"failures":["still no tests"]}'),
      ],
    });
    const { agent, store } = makeAgent(port);
    for await (const _ of agent.stream("start")) { /* drain */ }
    const result = lastToolResult(agent);
    expect(result.content[0]!.isError).toBe(true);
    expect(envelope(result)["verification"]).toMatchObject({
      status: "failed",
      attempts: 2,
      failures: ["no tests", "still no tests"],
    });
    expect(port.counts).toEqual({ parent: 2, child: 2, verifier: 2 });
    // The finished bracket reports the composed error, not a clean finish.
    const finished = (store.bySession.get("p") ?? []).find((e) => e.type === "subagent_finished")!;
    expect((finished.data as { isError: boolean }).isError).toBe(true);
  });

  it("makes no verifier call without acceptance", async () => {
    const port = routedPort({
      parent: [
        toolCallScript("c1", "task", JSON.stringify({ message: "do it" })),
        textScript("parent done"),
      ],
      child: [textScript("child output")],
      verifier: [],
    });
    const { agent } = makeAgent(port);
    for await (const _ of agent.stream("start")) { /* drain */ }
    expect(port.counts).toEqual({ parent: 2, child: 1, verifier: 0 });
    expect(envelope(lastToolResult(agent))).not.toHaveProperty("verification");
  });

  it("treats an unparseable verdict as error, not failure", async () => {
    const port = routedPort({
      parent: [DISPATCH_WITH_ACCEPTANCE, textScript("parent done")],
      child: [textScript("child output")],
      verifier: [textScript("looks good")],
    });
    const { agent } = makeAgent(port);
    for await (const _ of agent.stream("start")) { /* drain */ }
    const result = lastToolResult(agent);
    expect(result.content[0]!.isError).toBeUndefined();
    const verification = envelope(result)["verification"] as DispatchVerification;
    expect(verification).toMatchObject({ status: "error", attempts: 1 });
    expect(verification.verifierError).toBeDefined();
    // An error verdict never reworks: one child run, one verifier call.
    expect(port.counts).toEqual({ parent: 2, child: 1, verifier: 1 });
  });

  it("honours maxAcceptanceReworks=0", async () => {
    const port = routedPort({
      parent: [DISPATCH_WITH_ACCEPTANCE, textScript("parent done")],
      child: [textScript("v1")],
      verifier: [textScript('{"passed":false,"failures":["no tests"]}')],
    });
    const { agent } = makeAgent(port, { maxAcceptanceReworks: 0 });
    for await (const _ of agent.stream("start")) { /* drain */ }
    const result = lastToolResult(agent);
    expect(result.content[0]!.isError).toBe(true);
    expect(envelope(result)["verification"]).toMatchObject({ status: "failed", attempts: 1 });
    expect(port.counts).toEqual({ parent: 2, child: 1, verifier: 1 });
  });

  it("keeps failed when a rework run crashes", async () => {
    const port = routedPort({
      parent: [DISPATCH_WITH_ACCEPTANCE, textScript("parent done")],
      child: [textScript("v1"), [modelError("boom")]],
      verifier: [textScript('{"passed":false,"failures":["no tests"]}')],
    });
    const { agent } = makeAgent(port);
    for await (const _ of agent.stream("start")) { /* drain */ }
    const result = lastToolResult(agent);
    expect(result.content[0]!.isError).toBe(true);
    expect(envelope(result)["verification"]).toMatchObject({ status: "failed", attempts: 2 });
    // A crashed run is never verified.
    expect(port.counts).toEqual({ parent: 2, child: 2, verifier: 1 });
  });

  it("keeps failed when the final verification cannot complete", async () => {
    const port = routedPort({
      parent: [DISPATCH_WITH_ACCEPTANCE, textScript("parent done")],
      child: [textScript("v1"), textScript("v2")],
      verifier: [
        textScript('{"passed":false,"failures":["no tests"]}'),
        textScript("looks good"),
      ],
    });
    const { agent } = makeAgent(port);
    for await (const _ of agent.stream("start")) { /* drain */ }
    const result = lastToolResult(agent);
    expect(result.content[0]!.isError).toBe(true);
    const verification = envelope(result)["verification"] as DispatchVerification;
    expect(verification).toMatchObject({ status: "failed", attempts: 2, failures: ["no tests"] });
    expect(verification.verifierError).toBeDefined();
    expect(port.counts).toEqual({ parent: 2, child: 2, verifier: 2 });
  });

  it("sums verifier usage and carries the last retryHint", async () => {
    const port = routedPort({
      parent: [DISPATCH_WITH_ACCEPTANCE, textScript("parent done")],
      child: [textScript("v1", 100, 10), textScript("v2", 200, 20)],
      verifier: [
        textScript('{"passed":false,"failures":["no tests"],"retry_hint":"first hint"}', 11, 3),
        textScript('{"passed":false,"failures":["still no tests"],"retry_hint":"second hint"}', 22, 5),
      ],
    });
    const { agent } = makeAgent(port);
    for await (const _ of agent.stream("start")) { /* drain */ }
    const env = envelope(lastToolResult(agent));
    // Child usage accumulates across both attempts through the shared tap.
    expect(env["usage"]).toEqual({ inputTokens: 300, outputTokens: 30 });
    // Verifier usage is summed separately — never merged into the child's.
    expect(env["verification"]).toMatchObject({
      status: "failed",
      attempts: 2,
      retryHint: "second hint",
      usage: { inputTokens: 33, outputTokens: 8 },
    });
  });

  it("replays identically for the same scripted verdicts", async () => {
    const run = async () => {
      const port = routedPort({
        parent: [DISPATCH_WITH_ACCEPTANCE, textScript("parent done")],
        child: [textScript("child output")],
        verifier: [textScript('{"passed":true,"failures":[]}')],
      });
      const { agent } = makeAgent(port);
      for await (const _ of agent.stream("start")) { /* drain */ }
      return JSON.stringify(agent.getState().messages);
    };
    expect(await run()).toBe(await run());
  });
});