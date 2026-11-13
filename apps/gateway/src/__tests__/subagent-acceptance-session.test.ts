import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { textScript, toolCallScript } from "@voltojs/core";
import type { ModelEvent, ModelPort, ModelRequest } from "@voltojs/core";
import { startTestServer, type TestServer } from "./helpers.js";

/**
 * Task 9 (spec 2026-11-11 acceptance verification, D6): the host forwards
 * `maxAcceptanceReworks` through the wiring, and a REAL gateway session —
 * startTestServer + POST /messages + the /events SSE channel — streams the
 * failed acceptance verdict of a background dispatch on the parent channel.
 *
 * Only the ModelPort is scripted; the task tool, background registry,
 * acceptance loop, turn-boundary drain and SSE framer are the production path.
 */

// ──────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────

// Copied from packages/sdk/src/__tests__/subagent-acceptance.test.ts (test
// code is not shared across packages). Route scripts by request content,
// avoiding parent / child / verifier call order races. A slot is either a
// script queue or a handler function called on every request of that kind.
type Kind = "parent" | "child" | "verifier";
type PortSlot = ModelEvent[][] | ((req: ModelRequest) => ModelEvent[]);
function routedPort(scripts: Record<Kind, PortSlot>) {
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
      const slot = scripts[kind];
      const events = typeof slot === "function" ? slot(req) : slot[idx[kind]++]!;
      for (const event of events) yield event;
    },
  } as ModelPort & { counts: typeof counts };
}
// A sub-agent request always carries a system message; the test parent passes
// systemPrompt: null so the gateway seeds none; a verifier request always
// carries responseFormat. The HOME redirect below keeps user-level instruction
// files (~/.agents, ~/.claude) out of the parent's context layers — those ride
// system-role messages too and would misroute the parent into the child slot.

let tempHomeDir: string;
let originalHome: string | undefined;

beforeEach(async () => {
  tempHomeDir = await fs.mkdtemp(path.join(os.tmpdir(), "volto-acceptance-home-"));
  originalHome = process.env["HOME"];
  process.env["HOME"] = tempHomeDir;
});

afterEach(async () => {
  if (originalHome === undefined) delete process.env["HOME"];
  else process.env["HOME"] = originalHome;
  await fs.rm(tempHomeDir, { recursive: true, force: true });
  for (const server of servers) await server.close();
  servers.length = 0;
});

/** Servers started by a test, torn down after it so no handle leaks. */
const servers: TestServer[] = [];

async function boot(options: Parameters<typeof startTestServer>[0]): Promise<TestServer> {
  const server = await startTestServer(options);
  servers.push(server);
  return server;
}

/** Poll until `predicate` holds; fails loudly instead of passing silently. */
async function waitFor(predicate: () => boolean, what: string, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`waitFor: timed out waiting for ${what}`);
    await new Promise<void>((resolve) => setTimeout(resolve, 25));
  }
}

describe("subagent acceptance verdict on a real gateway session", () => {
  it("streams a failed verdict on the parent channel for a background dispatch", async () => {
    const port = routedPort({
      // Termination branch: the turn-boundary drain collects the uncollected
      // background task and REOPENS the turn, so every parent call after the
      // dispatch must end the turn — a linear two-entry script would run out
      // and loop/crash instead.
      parent: (req) =>
        req.messages.some((m) => m.role === "tool")
          ? textScript("parent done")
          : toolCallScript(
              "c1",
              "task",
              JSON.stringify({ message: "do it", acceptance: "tests pass", run_in_background: true }),
            ),
      child: [textScript("child output")],
      verifier: [textScript('{"passed":false,"failures":["no tests"]}')],
    });
    const server = await boot({
      modelPort: port,
      maxAcceptanceReworks: 0,
      // The content router tells parent from child by the system message;
      // the gateway's default system prompt would route the parent into the
      // child slot.
      systemPrompt: null,
    });

    await server.openEvents();
    const res = await fetch(`${server.url}/messages`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${server.token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ sessionId: server.sessionId, message: "start", ...server.turnConfig }),
    });
    expect(res.status).toBe(202);
    await server.captureMessages();
    // The child's OWN turn_end rides the parent channel too (sub-agent events
    // are forwarded inline), and it lands BEFORE the finished bracket — so
    // captureMessages may already have settled on it. Wait for the bracket
    // AND the parent turn_end that follows it (the turn-boundary drain keeps
    // the parent turn open until the verdict is known, so that ordering is
    // guaranteed, not timing luck).
    await waitFor(() => {
      const payloads = server.events();
      const finishedIdx = payloads.findIndex((e) => e.type === "subagent_finished");
      return (
        finishedIdx >= 0 &&
        payloads.some((e, i) => i > finishedIdx && e.type === "turn_end")
      );
    }, "subagent_finished and the parent turn_end after it");

    const events = server.events();
    const finished = events.find((e) => e.type === "subagent_finished");
    expect(finished).toBeDefined();
    expect((finished!.data["verification"] as Record<string, unknown>)["status"]).toBe("failed");

    // The bracket is stamped with the DISPATCH turn — the same turn as the
    // parent's tool_call / subagent_started for that dispatch. Relative, not
    // a hardcoded number: parent turns are 1-based here, and the assertion
    // must survive numbering changes.
    const dispatchCall = events.find((e) => e.type === "tool_call" && e.data["name"] === "task");
    expect(dispatchCall).toBeDefined();
    expect(typeof dispatchCall!.turn).toBe("number");
    expect(finished!.turn).toBe(dispatchCall!.turn);
    const started = events.find((e) => e.type === "subagent_started");
    expect(started).toBeDefined();
    expect(finished!.turn).toBe(started!.turn);

    // Budget passthrough proof: 0 reworks means exactly one child run and one
    // verifier call. Without the wiring forwarding the option, the SDK default
    // (1) would rework the failed verdict and run the child a second time.
    expect(port.counts).toEqual({ parent: 3, child: 1, verifier: 1 });
  });
});
