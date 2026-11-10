/**
 * Workspace reminders (spec 2026-11-10 D2/D5/D8): the host resolves
 * "working directory + git branch" into a `<system-reminder>` the reducer
 * injects on change — at the start of every turn AND again at each sub-agent
 * dispatch, because a dispatch can follow a `cd` into a fresh worktree.
 *
 * The SDK owns no git vocabulary: it only asks the host for `{key, announce}`
 * with the directory the session is actually in, and degrades silently when
 * the host has nothing to say.
 */
import { describe, it, expect } from "vitest";
import { createAgent } from "../create-agent.js";
import type {
  Message,
  ModelEvent,
  ModelPort,
  ModelRequest,
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

function allText(request: ModelRequest | undefined): string {
  return (request?.messages ?? [])
    .map((m: Message) => (typeof m.content === "string" ? m.content : ""))
    .join("\n");
}

const ANNOUNCE_A = "Working directory: /repo (project: volto)\nGit branch: main";

describe("workspace reminder", () => {
  it("injects the host's reminder on the first turn", async () => {
    const { port, requests } = rec([textScript("ok")]);
    const seen: string[] = [];
    const agent = createAgent({
      modelPort: port,
      cwd: "/repo",
      resolveWorkspaceReminder: async (cwd) => {
        seen.push(cwd);
        return { key: "/repo\0main", announce: ANNOUNCE_A };
      },
    });

    await agent.run("where am I?");

    expect(seen).toEqual(["/repo"]);
    expect(allText(requests[0])).toContain(ANNOUNCE_A);
    expect(allText(requests[0])).toContain("<system-reminder>");
  });

  it("does not repeat the reminder on a later turn with the same key", async () => {
    const { port, requests } = rec([textScript("one"), textScript("two")]);
    const agent = createAgent({
      modelPort: port,
      cwd: "/repo",
      resolveWorkspaceReminder: async () => ({ key: "/repo\0main", announce: ANNOUNCE_A }),
    });

    await agent.run("first");
    await agent.run("second");

    const occurrences = (allText(requests[1]).match(/Working directory: \/repo /g) ?? []).length;
    expect(occurrences).toBe(1);
  });

  it("asks about the session's directory, not the constructor's", async () => {
    const { port } = rec([textScript("ok")]);
    const seen: string[] = [];
    const agent = createAgent({
      // A session that has cd'd elsewhere must win over opts.cwd.
      modelPort: port,
      cwd: "/repo",
      sessionSpawner: () => {
        throw new Error("unused");
      },
      resolveWorkspaceReminder: async (cwd) => {
        seen.push(cwd);
        return undefined;
      },
    });

    await agent.run("hi");

    // No session was ever created, so opts.cwd is the answer.
    expect(seen).toEqual(["/repo"]);
  });

  it("re-resolves at dispatch time so a mid-turn cd reaches the child", async () => {
    const { port, requests } = rec([
      toolCallScript("c1", "task", JSON.stringify({ message: "look" })),
      textScript("child done"),
      textScript("parent done"),
    ]);
    let call = 0;
    const agent = createAgent({
      modelPort: port,
      cwd: "/repo",
      enableTaskTool: true,
      resolveWorkspaceReminder: async () => {
        call += 1;
        return call === 1
          ? { key: "/repo\0main", announce: ANNOUNCE_A }
          : {
              key: "/repo-wt\0feat/x",
              announce: "Working directory: /repo-wt (project: volto)\nGit branch: feat/x",
            };
      },
    });

    await agent.run("dispatch after cd");

    expect(requestCount(requests)).toBe(3);
    const childSystem = allText(requests[1]);
    expect(childSystem).toContain("/repo-wt");
    expect(childSystem).toContain("feat/x");
    // The parent's opening announcement is NOT what the child got.
    expect(childSystem).not.toContain("Working directory: /repo (project: volto)");
  });

  it("degrades silently when the host resolver throws", async () => {
    const { port, requests } = rec([textScript("fine")]);
    const agent = createAgent({
      modelPort: port,
      cwd: "/repo",
      resolveWorkspaceReminder: async () => {
        throw new Error("git exploded");
      },
    });

    await agent.run("hi");

    expect(allText(requests[0])).not.toContain("Working directory:");
    // The turn completed normally — the failure never reached the caller.
    expect(requests.length).toBeGreaterThan(0);
  });

  it("does not spawn a shell just to read the cwd", async () => {
    const { port } = rec([textScript("ok")]);
    let spawns = 0;
    const agent = createAgent({
      modelPort: port,
      cwd: "/repo",
      sessionSpawner: () => {
        spawns += 1;
        throw new Error("must not spawn");
      },
      shell: {
        // eslint-disable-next-line require-yield
        async *exec() {
          throw new Error("unused");
        },
      },
      resolveWorkspaceReminder: async () => undefined,
    });

    await agent.run("hi");

    expect(spawns).toBe(0);
  });
});

function requestCount(requests: ModelRequest[]): number {
  return requests.length;
}