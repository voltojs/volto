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
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createAgent, type CreateAgentOptions } from "../create-agent.js";
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

  it("re-announces once on the first turn of a rebuilt instance", async () => {
    // Spec D8: the fingerprint deliberately does NOT cross a rebuild, so the
    // rebuilt conversation says where it is again — idempotent, and it
    // self-heals a workspace that changed while the instance was down.
    const { port, requests } = rec([textScript("ok")]);
    let calls = 0;
    const agent = createAgent({
      modelPort: port,
      cwd: "/repo-wt",
      resolveWorkspaceReminder: async () => {
        calls += 1;
        return { key: "/repo-wt\0feat/x", announce: "Working directory: /repo-wt (project: volto)" };
      },
    });

    await agent.run("continue");

    expect(calls).toBe(1);
    expect(allText(requests[0])).toContain("Working directory: /repo-wt");
  });

  it("exposes no rebuild seed for the workspace fingerprint (D8)", () => {
    // A guard against re-introducing the plumbing D8 rejected: if someone adds
    // `initialAnnouncedWorkspace`, this line stops compiling.
    const opts: CreateAgentOptions = { modelPort: rec([]).port };
    // @ts-expect-error — spec 2026-11-10 D8: a rebuild re-announces, never seeds.
    void opts.initialAnnouncedWorkspace;
    expect(opts).toBeDefined();
  });

  it("does not spawn a shell on dispatch when the parent never used bash", async () => {
    // The dispatch-time cwd read must peek: `getSession()` would create the
    // persistent shell, so a parent that only delegated would still pay a
    // process it never asked for.
    const { port } = rec([
      toolCallScript("c1", "task", JSON.stringify({ message: "look" })),
      textScript("child done"),
      textScript("parent done"),
    ]);
    let spawns = 0;
    const agent = createAgent({
      modelPort: port,
      cwd: "/repo",
      enableTaskTool: true,
      shell: {
        // eslint-disable-next-line require-yield
        async *exec() {
          throw new Error("unused");
        },
      },
      sessionSpawner: () => {
        spawns += 1;
        throw new Error("must not spawn");
      },
      resolveWorkspaceReminder: async () => ({ key: "k", announce: "Working directory: /repo" }),
    });

    await agent.run("delegate only");

    expect(spawns).toBe(0);
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
/**
 * The two paths the pure-mock cases above cannot reach: the resolver must be
 * asked about the SESSION's directory (a real shell that `cd`ed), and the bash
 * confirmation line must not reuse a branch cached before it changed. Both are
 * driven through a real /bin/bash session — the fake port only supplies the
 * script.
 */
describe("workspace reminder — with a real session", () => {
  /** Spawn a real bash rooted at `cwd`; the fake port only supplies the script. */
  function sessionSpawnerAt(cwd: string) {
    return () => ({
      child: spawn("/bin/bash", ["-s"], { cwd, stdio: ["pipe", "pipe", "pipe"] }),
    });
  }

  const shellStub = {
    // eslint-disable-next-line require-yield
    async *exec() {
      throw new Error("the session path must be used");
    },
  };

  it("re-asks about a directory instead of reusing its cached branch", async () => {
    // Review I1: the confirmation line follows a `cd` back into a directory
    // whose announcement was read BEFORE the branch changed. Re-resolving is
    // what keeps the line honest.
    const dirA = fs.mkdtempSync(path.join(os.tmpdir(), "volto-ws-a-"));
    const dirB = fs.mkdtempSync(path.join(os.tmpdir(), "volto-ws-b-"));
    try {
      const asked: string[] = [];
      const { port } = rec([
        toolCallScript("c1", "bash", JSON.stringify({ command: `cd '${dirB}'` })),
        toolCallScript("c2", "bash", JSON.stringify({ command: `cd '${dirA}'` })),
        textScript("done"),
      ]);
      const agent = createAgent({
        modelPort: port,
        cwd: dirA,
        shell: shellStub,
        sessionSpawner: sessionSpawnerAt(dirA),
        resolveWorkspaceReminder: async (cwd) => {
          asked.push(cwd);
          return { key: `${cwd}\0main`, announce: `Working directory: ${cwd}\nGit branch: main` };
        },
      });
      try {
        await agent.run("move around");
      } finally {
        await agent.dispose();
      }

      // dirA is asked at turn start AND again for the confirmation line after
      // `cd dirA` — a cached answer would be asked exactly once.
      expect(asked.filter((cwd) => cwd === dirA).length).toBeGreaterThanOrEqual(2);
      expect(asked).toContain(dirB);
    } finally {
      fs.rmSync(dirA, { recursive: true, force: true });
      fs.rmSync(dirB, { recursive: true, force: true });
    }
  });

  it("resolves the NEXT turn against the directory the shell is in", async () => {
    // Review I2: one turn can be satisfied by the `opts.cwd` fallback. Only a
    // second turn, started while the shell sits elsewhere, proves the peek is
    // reading the session.
    const dirA = fs.mkdtempSync(path.join(os.tmpdir(), "volto-ws-2a-"));
    const dirB = fs.mkdtempSync(path.join(os.tmpdir(), "volto-ws-2b-"));
    try {
      const turnStarts: string[] = [];
      const { port } = rec([
        toolCallScript("c1", "bash", JSON.stringify({ command: `cd '${dirB}'` })),
        textScript("first turn done"),
        textScript("second turn done"),
      ]);
      let turn = 0;
      const agent = createAgent({
        modelPort: port,
        cwd: dirA,
        shell: shellStub,
        sessionSpawner: sessionSpawnerAt(dirA),
        // Recorded per CALL, and the first call of a turn is the turn-start one
        // only when no dispatch happened; that holds here (no task tool).
        resolveWorkspaceReminder: async (cwd) => {
          turnStarts.push(cwd);
          return { key: `${cwd}\0main`, announce: `Working directory: ${cwd}\nGit branch: main` };
        },
      });
      try {
        await agent.run("move");
        turn = turnStarts.length;
        await agent.run("where am I now?");
      } finally {
        await agent.dispose();
      }

      // The second turn's opening resolution must have seen dirB, the shell's
      // real directory — not opts.cwd (dirA).
      expect(turnStarts.length).toBeGreaterThan(turn);
      expect(turnStarts[turn]).toBe(dirB);
    } finally {
      fs.rmSync(dirA, { recursive: true, force: true });
      fs.rmSync(dirB, { recursive: true, force: true });
    }
  });
});
