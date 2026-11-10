/**
 * Sub-agent context layers (spec 2026-11-10 D6).
 *
 * A dispatched child used to start from a clean context — its own role prompt
 * plus, at most, a skill catalog. That left AGENTS.md (coding conventions, git
 * rules, language rules) invisible to every sub-agent, which is exactly the
 * "child behaves unlike the project" drift the spec closes. The host layers
 * now cross the dispatch boundary; the parent's own skill catalog does NOT
 * (the child rebuilds its own), so a rebuilt instance cannot hand the child a
 * stale duplicate.
 */
import { describe, it, expect } from "vitest";
import { createAgent } from "../create-agent.js";
import type {
  ContextLayer,
  Message,
  ModelEvent,
  ModelPort,
  ModelRequest,
  SkillRegistry,
} from "@volto/core";
import { createMockModelPort, textScript, toolCallScript } from "@volto/core";

function rec(script: ModelEvent[][]) {
  const requests: ModelRequest[] = [];
  const inner = createMockModelPort(script);
  const port: ModelPort = {
    async *stream(req: ModelRequest): AsyncIterable<ModelEvent> {
      requests.push(req);
      yield* inner.stream(req);
    },
  };
  return { port, requests };
}

function allSystemText(request: ModelRequest | undefined): string {
  return (request?.messages ?? [])
    .filter((m: Message) => m.role === "system")
    .map((m: Message) => (typeof m.content === "string" ? m.content : ""))
    .join("\n---\n");
}

function count(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

/** Two scripted dispatches: parent asks for a task, child answers, parent ends. */
function dispatchScript(): ModelEvent[][] {
  return [
    toolCallScript("c1", "task", JSON.stringify({ message: "do it" })),
    textScript("child done"),
    textScript("parent done"),
  ];
}

const SKILLS: SkillRegistry = {
  async list() {
    return [
      {
        name: "alpha",
        description: "Alpha skill",
        invocation: { modelInvocable: true, userInvocable: true },
        path: "/skills/alpha",
      },
    ] as unknown as Awaited<ReturnType<SkillRegistry["list"]>>;
  },
  async load() {
    return { name: "alpha", body: "alpha body" } as unknown as Awaited<
      ReturnType<SkillRegistry["load"]>
    >;
  },
} as SkillRegistry;

describe("sub-agent host instruction layers", () => {
  it("hands the resolved host layers to the child", async () => {
    const { port, requests } = rec(dispatchScript());
    const agent = createAgent({
      modelPort: port,
      enableTaskTool: true,
      resolveContextLayers: async () => [{ id: "project", text: "PROJECT RULE 42" }],
    });

    await agent.run("delegate");

    const childSystem = allSystemText(requests[1]);
    expect(childSystem).toContain("PROJECT RULE 42");
    // Exactly once: the parent's copy must not be replayed alongside it.
    expect(count(childSystem, "PROJECT RULE 42")).toBe(1);
  });

  it("keeps the child's own skill catalog alongside the host layers", async () => {
    const { port, requests } = rec(dispatchScript());
    const agent = createAgent({
      modelPort: port,
      enableTaskTool: true,
      skillRegistry: SKILLS,
      resolveContextLayers: async () => [{ id: "project", text: "PROJECT RULE 42" }],
    });

    await agent.run("delegate");

    const childSystem = allSystemText(requests[1]);
    expect(childSystem).toContain("PROJECT RULE 42");
    expect(childSystem).toContain("alpha");
    // One catalog, not the parent's plus the child's.
    expect(count(childSystem, "Available skills")).toBe(1);
  });

  it("adds nothing when the host resolves no layers", async () => {
    const { port, requests } = rec(dispatchScript());
    const agent = createAgent({ modelPort: port, enableTaskTool: true });

    await agent.run("delegate");

    // Only the built-in sub-agent role prompt: the pre-existing shape.
    const childSystem = allSystemText(requests[1]);
    expect(childSystem).not.toContain("PROJECT RULE 42");
  });

  it("keeps host layers but drops the stale catalog on a rebuilt instance", async () => {
    // A rebuild seeds `initialContextLayers` with the previous header's
    // system layers — which already include the parent's skill catalog, so
    // the host resolver never runs again. The child must still get the
    // instruction layers, and must NOT inherit that stale catalog twice.
    const seeded: ContextLayer[] = [
      { id: "project", text: "PROJECT RULE 42" },
      { id: "skill-catalog", text: "STALE CATALOG FROM THE PREVIOUS INSTANCE" },
    ];
    const { port, requests } = rec(dispatchScript());
    const agent = createAgent({
      modelPort: port,
      enableTaskTool: true,
      skillRegistry: SKILLS,
      initialContextLayers: seeded,
      // A rebuild never calls the host resolver again; asserting that keeps
      // this test honest about which path it exercises.
      resolveContextLayers: async () => {
        throw new Error("must not re-resolve after a rebuild seed");
      },
    });

    await agent.run("delegate");

    const childSystem = allSystemText(requests[1]);
    expect(childSystem).toContain("PROJECT RULE 42");
    expect(childSystem).not.toContain("STALE CATALOG FROM THE PREVIOUS INSTANCE");
    expect(count(childSystem, "Available skills")).toBe(1);
  });
});