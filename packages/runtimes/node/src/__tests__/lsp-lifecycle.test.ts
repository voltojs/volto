/**
 * LSP lifecycle tests — F-113 / F-114 / F-115.
 *
 * These drive the REAL fixture child process (`fixtures/lsp-server.mjs`); no
 * part of the process lifetime is mocked. "The server is gone" is asserted on
 * the OS (the fixture writes its own pid to a file, and the test checks that
 * `process.kill(pid, 0)` throws ESRCH) rather than on a return value, because a
 * return value says what the manager believes, not what the machine shows.
 *
 * `sandbox: { mode: "danger-full-access" }` keeps the suite platform-neutral:
 * confinement has its own suite (`sandboxed-process.test.ts`).
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createNodeFileSystem } from "../filesystem.js";
import { createNodeLspManager } from "../lsp.js";
import type { LspManager, LspManagerOptions } from "../lsp.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE = join(HERE, "fixtures", "lsp-server.mjs");
const uri = (p: string): string => `file://${p}`;

interface FixtureMessage {
  method?: string;
  params?: { textDocument?: { uri?: string; version?: number } };
  [key: string]: unknown;
}

/** A clock the test advances by hand; nothing here waits on real time. */
function manualClock(start = 1_700_000_000_000) {
  let current = start;
  return {
    now: () => current,
    advance: (ms: number): void => {
      current += ms;
    },
  };
}

const fixedClock = { now: () => 1_700_000_000_000 };

let workspaceRoot = "";
let realFs: ReturnType<typeof createNodeFileSystem>;
let file = "";
let jsonFile = "";
/** Managers created by the current test, disposed (and reaped) afterwards. */
let managers: LspManager[] = [];
let scratchDir = "";
let logPath = "";
let pidPath = "";
let savedEnv: Record<string, string | undefined> = {};

function mkManager(over: Partial<LspManagerOptions> & { mode?: string } = {}): LspManager {
  const { mode = "ok", ...rest } = over;
  const manager = createNodeLspManager({
    workspaceRoot,
    fs: realFs,
    clock: fixedClock,
    servers: { typescript: { command: process.execPath, args: [FIXTURE, mode] } },
    sandbox: { mode: "danger-full-access" },
    ...rest,
  });
  managers.push(manager);
  return manager;
}

/** Every pid the fixture has written, oldest first (one line per spawn). */
function readPids(): number[] {
  try {
    return readFileSync(pidPath, "utf-8")
      .split("\n")
      .filter((line) => line.trim().length > 0)
      .map((line) => Number.parseInt(line, 10));
  } catch {
    return [];
  }
}

/** Wait until the fixture has announced at least `count` pids. */
async function waitForPids(count = 1): Promise<number[]> {
  const deadline = Date.now() + 5_000;
  for (;;) {
    const pids = readPids();
    if (pids.length >= count) return pids;
    if (Date.now() > deadline) throw new Error("the fixture never wrote its pid");
    await sleep(10);
  }
}

function readFixtureLog(): FixtureMessage[] {
  try {
    return readFileSync(logPath, "utf-8")
      .split("\n")
      .filter((line) => line.trim().length > 0)
      .map((line) => JSON.parse(line) as FixtureMessage);
  } catch {
    return [];
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((done) => setTimeout(done, ms));
}

/** Wait until the fixture has logged at least `count` messages. */
async function waitForLog(count: number): Promise<FixtureMessage[]> {
  const deadline = Date.now() + 15_000;
  for (;;) {
    const messages = readFixtureLog();
    if (messages.length >= count) return messages;
    if (Date.now() > deadline) {
      throw new Error(
        `fixture log did not reach ${count} messages (saw ${messages.length}): ${JSON.stringify(messages)}`,
      );
    }
    await sleep(10);
  }
}

beforeEach(() => {
  managers = [];
  // The workspace and the fixture's own log/pid live in OS temp dirs: nothing
  // tracked is written, and no other suite can see them.
  workspaceRoot = mkdtempSync(join(tmpdir(), "volto-lsp-lifecycle-ws-"));
  realFs = createNodeFileSystem({ root: workspaceRoot });
  file = join(workspaceRoot, "lifecycle.ts");
  jsonFile = join(workspaceRoot, "lifecycle.json");
  writeFileSync(file, "// scratch lifecycle\n", "utf-8");
  writeFileSync(jsonFile, '{"scratch": true}\n', "utf-8");

  scratchDir = mkdtempSync(join(tmpdir(), "volto-lsp-lifecycle-"));
  logPath = join(scratchDir, "fixture.log");
  pidPath = join(scratchDir, "fixture.pid");
  const env: Record<string, string> = {
    LSP_FIXTURE_LOG: logPath,
    LSP_FIXTURE_PIDFILE: pidPath,
    LSP_FIXTURE_DIE_ONCE: join(scratchDir, "fixture.died"),
  };
  savedEnv = {};
  for (const [key, value] of Object.entries(env)) {
    savedEnv[key] = process.env[key];
    process.env[key] = value;
  }
});

afterEach(async () => {
  for (const manager of managers) {
    await manager.dispose().catch(() => undefined);
  }
  managers = [];
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  rmSync(scratchDir, { recursive: true, force: true });
  rmSync(workspaceRoot, { recursive: true, force: true });
});

describe("LSP idle reclamation", () => {
  it("F-113 reclaims a server only once the injected clock passes the idle budget", async () => {
    const clock = manualClock();
    const mgr = mkManager({ idleTimeoutMs: 1_000, clock });
    const client = await mgr.forFile(file);
    const pids = readPids();
    expect(pids).toHaveLength(1);
    const pid = pids[0]!;

    // One millisecond short of the budget: the server is still current.
    clock.advance(999);
    await mgr.sweepIdle(clock.now());
    expect(() => process.kill(pid, 0)).not.toThrow();

    // Past the budget: the process must really be gone by the time the await
    // returns — a reclaim that only signals would still answer ping here.
    clock.advance(2);
    await mgr.sweepIdle(clock.now());
    expect(() => process.kill(pid, 0)).toThrow(/ESRCH/);

    // Reclaiming is not a failure: the next caller gets a fresh server, and
    // that server is re-synced (a stale document map would send didChange
    // against a process that never received didOpen).
    await expect(client.hover(uri(file), 0, 0)).resolves.toMatchObject({
      contents: expect.stringContaining("fixture hover"),
    });
    expect(readPids()).toHaveLength(2);
  });

  it("F-113 never reclaims a server with an in-flight request", async () => {
    const clock = manualClock();
    const mgr = mkManager({
      mode: "silent",
      idleTimeoutMs: 1_000,
      requestTimeoutMs: 30_000,
      clock,
    });
    const client = await mgr.forFile(file);
    const pid = readPids()[0]!;

    // `silent` completes the handshake and then never answers, so the hover
    // stays pending; wait for the fixture to log it, so the request is provably
    // in flight before the sweep runs.
    const hover = client.hover(uri(file), 0, 0);
    hover.catch(() => undefined);
    await waitForLog(4);

    clock.advance(600_000);
    await mgr.sweepIdle(clock.now());
    expect(() => process.kill(pid, 0)).not.toThrow();

    await mgr.dispose();
    expect(() => process.kill(pid, 0)).toThrow(/ESRCH/);
  });
});

describe("LSP dispose", () => {
  it("F-114 dispose reaps every language's server and leaves no orphan", async () => {
    const mgr = mkManager({
      servers: {
        typescript: { command: process.execPath, args: [FIXTURE, "ok"] },
        json: { command: process.execPath, args: [FIXTURE, "ok"] },
      },
    });
    const tsClient = await mgr.forFile(file);
    const jsonClient = await mgr.forFile(jsonFile);
    await tsClient.hover(uri(file), 0, 0);
    await jsonClient.hover(uri(jsonFile), 0, 0);

    const pids = readPids();
    expect(new Set(pids).size).toBe(2);

    await mgr.dispose();

    // `dispose()` resolving must mean "the children are gone", not "a signal
    // was sent": asserting right here is the whole point of F-114.
    for (const pid of pids) {
      expect(() => process.kill(pid, 0)).toThrow(/ESRCH/);
    }
    // A disposed manager must not quietly start a third child afterwards.
    await expect(mgr.forFile(file)).rejects.toMatchObject({ code: "LSP_UNAVAILABLE" });
    expect(readPids()).toHaveLength(2);
  });

  it("F-114 dispose reaps a child whose initialize handshake is still in flight", async () => {
    const mgr = mkManager({ mode: "silent-init", initializationTimeoutMs: 30_000 });
    // `silent-init` answers nothing at all, so this call is parked on the
    // handshake — the child exists but is not usable yet.
    const booting = mgr.forFile(file);
    booting.catch(() => undefined);
    const pid = (await waitForPids())[0]!;

    const startedAt = Date.now();
    await mgr.dispose();

    // The handshake budget is 30s, so a dispose that merely waited for it would
    // sit here for half a minute; returning in under four seconds means the
    // child was killed, not waited out.
    expect(Date.now() - startedAt).toBeLessThan(4_000);
    expect(() => process.kill(pid, 0)).toThrow(/ESRCH/);
    await expect(booting).rejects.toMatchObject({ code: "LSP_UNAVAILABLE" });
  });
});

describe("LSP crash recovery", () => {
  it("F-115 replays the crashed request once on a fresh, re-synced server", async () => {
    const mgr = mkManager({ mode: "die-once" });
    const client = await mgr.forFile(file);

    // The first attempt kills the server; the manager replaces it and replays
    // the request that never received an answer, so the CALLER sees success
    // instead of losing a turn to a transient crash.
    await expect(client.definition(uri(file), 0, 0)).resolves.toHaveLength(1);

    const log = await waitForLog(8);
    expect(log.map((m) => m.method)).toEqual([
      "initialize",
      "initialized",
      "textDocument/didOpen",
      "textDocument/definition",
      "initialize",
      "initialized",
      "textDocument/didOpen",
      "textDocument/definition",
    ]);
    // Both processes were told about the document from scratch: the replacement
    // must not inherit didOpen versions recorded for the process that died.
    expect(log[2]!.params?.textDocument?.version).toBe(1);
    expect(log[6]!.params?.textDocument?.version).toBe(1);
  });

  it("F-115 consumes its one restart on a server that keeps crashing, then fast-fails", async () => {
    const mgr = mkManager({ mode: "die-on-request" });
    const client = await mgr.forFile(file);

    // The call meets the crash, restarts once and replays; the replacement dies
    // the same way, so this call fails with the death (not with a hang) and the
    // language is marked unavailable for the session.
    await expect(client.definition(uri(file), 0, 0)).rejects.toMatchObject({
      code: "LSP_UNAVAILABLE",
      message: expect.stringContaining("exited unexpectedly"),
    });
    const spawned = readPids();
    expect(spawned).toHaveLength(2);
    for (const pid of spawned) {
      expect(() => process.kill(pid, 0)).toThrow(/ESRCH/);
    }

    // From here on the call fails fast: no third child is ever started.
    await expect(client.definition(uri(file), 0, 0)).rejects.toThrow(/unavailable/);
    await sleep(200); // a negative assertion needs a settle window
    expect(readPids()).toHaveLength(2);
    expect(readFixtureLog().filter((m) => m.method === "initialize")).toHaveLength(2);
  });
});

describe("LSP request timeout", () => {
  it("F-109 reaps the wedged server, never replays the timed-out request, and keeps recovering", async () => {
    const mgr = mkManager({ mode: "silent", requestTimeoutMs: 200 });
    const client = await mgr.forFile(file);

    // `silent` never exits on its own, so a gone pid can only be the manager's
    // doing — and it is already gone when the rejection reaches the caller.
    await expect(client.hover(uri(file), 0, 0)).rejects.toThrow(/did not respond/);
    const first = readPids();
    expect(first).toHaveLength(1);
    expect(() => process.kill(first[0]!, 0)).toThrow(/ESRCH/);

    // The timed-out request is NOT replayed (its answer may exist, only too
    // late): exactly one new server serves this new call.
    await expect(client.hover(uri(file), 0, 0)).rejects.toThrow(/did not respond/);
    expect(readPids()).toHaveLength(2);

    // A timeout is not a crash, so it must not count towards `unavailable`: a
    // third call still gets a fresh server to time out against.
    await expect(client.hover(uri(file), 0, 0)).rejects.toThrow(/did not respond/);
    expect(readPids()).toHaveLength(3);
  });
});
