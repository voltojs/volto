/**
 * LSP manager tests — these drive a REAL child process (the fixture server in
 * `fixtures/lsp-server.mjs`), never a mock. Protocol assertions are made on
 * the wire traffic the fixture logs, and containment/probe assertions on the
 * manager's own error codes.
 *
 * `sandbox: { mode: "danger-full-access" }` keeps the suite platform-neutral:
 * confinement itself is covered by `sandboxed-process.test.ts`.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { createNodeFileSystem } from "../filesystem.js";
import { createNodeLspManager } from "../lsp.js";
import type { LspManager, LspManagerOptions } from "../lsp.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE = join(HERE, "fixtures", "lsp-server.mjs");
// HERE is <repo>/packages/runtimes/node/src/__tests__; the repo root is four
// levels up from the package's `src` (i.e. five from HERE).
const repoRoot = resolve(HERE, "../../../../..");

const file = join(repoRoot, "packages/runtimes/node/src/lsp.ts");
const relativeInside = "packages/runtimes/node/src/lsp.ts";
const uri = (p: string): string => `file://${p}`;

interface FixtureMessage {
  method?: string;
  params?: { textDocument?: { version?: number } };
  [key: string]: unknown;
}

const realFs = createNodeFileSystem({ root: repoRoot });
const fixedClock = { now: () => 1_700_000_000_000 };

/** Managers created by the current test, disposed (and reaped) afterwards. */
let managers: LspManager[] = [];
let logPath = "";
let scratchDir = "";
let savedLog: string | undefined;
let savedPid: string | undefined;

function mkManager(over: Partial<LspManagerOptions> = {}): LspManager {
  const manager = createNodeLspManager({
    workspaceRoot: repoRoot,
    fs: realFs,
    clock: fixedClock,
    servers: { typescript: { command: process.execPath, args: [FIXTURE, "ok"] } },
    sandbox: { mode: "danger-full-access" },
    ...over,
  });
  managers.push(manager);
  return manager;
}

/** The fixture appends one JSON line per received message. */
function readFixtureLog(): FixtureMessage[] {
  let raw: string;
  try {
    raw = readFileSync(logPath, "utf-8");
  } catch {
    return [];
  }
  return raw
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as FixtureMessage);
}

function sleep(ms: number): Promise<void> {
  return new Promise((done) => setTimeout(done, ms));
}

/**
 * Wait until the fixture has logged at least `count` messages and the log has
 * stopped growing. A response can reach our process before the fixture's own
 * log write is visible, so asserting immediately after a request resolves can
 * read a truncated log — this makes the assertion deterministic instead.
 */
async function waitForLog(count: number): Promise<FixtureMessage[]> {
  const deadline = Date.now() + 15_000;
  let stable = 0;
  for (;;) {
    const messages = readFixtureLog();
    if (messages.length >= count) {
      stable += 1;
      if (stable >= 3) return messages;
    } else {
      stable = 0;
    }
    if (Date.now() > deadline) {
      throw new Error(
        `fixture log did not reach ${count} messages (saw ${messages.length}): ${JSON.stringify(messages)}`,
      );
    }
    await sleep(10);
  }
}

/** Replace a file's contents, restoring it in `afterEach` if needed. */
function writeFile(path: string, text: string): void {
  writeFileSync(path, text, "utf-8");
}

beforeEach(() => {
  managers = [];
  scratchDir = mkdtempSync(join(tmpdir(), "volto-lsp-fixture-"));
  logPath = join(scratchDir, "fixture.log");
  savedLog = process.env["LSP_FIXTURE_LOG"];
  savedPid = process.env["LSP_FIXTURE_PIDFILE"];
  // The sandboxed process spawner rebuilds the child environment from the
  // host's, so pointing the fixture at per-test files is done here.
  process.env["LSP_FIXTURE_LOG"] = logPath;
  process.env["LSP_FIXTURE_PIDFILE"] = join(scratchDir, "fixture.pid");
});

afterEach(async () => {
  for (const manager of managers) {
    await manager.dispose().catch(() => undefined);
  }
  managers = [];
  if (savedLog === undefined) delete process.env["LSP_FIXTURE_LOG"];
  else process.env["LSP_FIXTURE_LOG"] = savedLog;
  if (savedPid === undefined) delete process.env["LSP_FIXTURE_PIDFILE"];
  else process.env["LSP_FIXTURE_PIDFILE"] = savedPid;
  rmSync(scratchDir, { recursive: true, force: true });
});

describe("LSP manager document sync", () => {
  it("F-107 任何请求之前必发 didOpen，改盘后 didChange 且 version 递增", async () => {
    const original = readFileSync(file, "utf-8");
    try {
      writeFile(file, "// lint fixture v1\n");
      const mgr = mkManager();
      const client = await mgr.forFile(file);
      await client.definition(uri(file), 0, 0);

      writeFile(file, "// lint fixture v2\n");
      await client.definition(uri(file), 0, 0);

      const log = await waitForLog(6);
      expect(log.map((m) => m.method)).toEqual([
        "initialize",
        "initialized",
        "textDocument/didOpen",
        "textDocument/definition",
        "textDocument/didChange",
        "textDocument/definition",
      ]);
      expect(log[2]!.params?.textDocument?.version).toBe(1);
      expect(log[4]!.params?.textDocument?.version).toBe(2);
    } finally {
      writeFile(file, original);
    }
  });

  it("F-107 并发请求只发一次 didOpen，且按 id 正确配对", async () => {
    const mgr = mkManager();
    const client = await mgr.forFile(file);
    const [a, b] = await Promise.all([
      client.hover(uri(file), 0, 0),
      client.references(uri(file), 0, 0),
    ]);
    const log = await waitForLog(5);
    expect(log.filter((m) => m.method === "textDocument/didOpen")).toHaveLength(1);
    expect(a).not.toEqual(b);
    // The two responses were routed by id, not by arrival order: hover answers
    // with `{ contents }` and references with an array.
    expect(a).toMatchObject({ contents: expect.stringContaining("fixture hover") });
    expect(Array.isArray(b)).toBe(true);
  });
});

describe("LSP manager path containment", () => {
  it("F-106 相对路径归一；越界抛 LSP_PATH_OUTSIDE_WORKSPACE", async () => {
    const mgr = mkManager();
    await expect(mgr.forFile("../../etc/passwd")).rejects.toMatchObject({
      code: "LSP_PATH_OUTSIDE_WORKSPACE",
    });
    await expect(mgr.forFile(relativeInside)).resolves.toBeDefined();
  });
});

describe("LSP manager failure normalization", () => {
  it("F-108 服务器缺失 → LSP_SERVER_MISSING，且无未捕获异常", async () => {
    const mgr = mkManager({
      servers: { typescript: { command: "/nonexistent/volto-lsp" } },
    });
    await expect(mgr.forFile(file)).rejects.toMatchObject({
      code: "LSP_SERVER_MISSING",
    });
  });

  it("F-108 装上服务器后重试能成功（probe 不被缓存）", async () => {
    // A probe whose answer changes between calls is exactly what the cached
    // `probeBinary` in sandbox.ts cannot model: the first attempt must fail
    // with LSP_SERVER_MISSING, the retry must actually re-probe and start.
    const answers = [
      { available: false },
      { available: true, path: process.execPath },
    ];
    let calls = 0;
    const mgr = mkManager({ probe: () => answers[Math.min(calls++, answers.length - 1)]! });

    await expect(mgr.forFile(file)).rejects.toMatchObject({ code: "LSP_SERVER_MISSING" });
    const client = await mgr.forFile(file);
    expect(calls).toBe(2);
    await expect(client.hover(uri(file), 0, 0)).resolves.toMatchObject({
      contents: expect.stringContaining("fixture hover"),
    });
  });

  it("F-109 不回包的服务器 → 超时 isError，turn 不挂死", async () => {
    const mgr = mkManager({
      servers: { typescript: { command: process.execPath, args: [FIXTURE, "silent"] } },
      requestTimeoutMs: 300,
      // The handshake is bounded too, but separately — see LspManagerOptions.
      initializationTimeoutMs: 10_000,
    });
    const client = await mgr.forFile(file);
    const beforeHover = readFixtureLog().length;

    await expect(client.hover(uri(file), 0, 0)).rejects.toThrow(
      /did not (initialize|respond)/,
    );

    // The request did reach the server; it is the answer that never came.
    const log = await waitForLog(beforeHover + 1);
    const last = log[log.length - 1]!;
    expect(last.method).toBe("textDocument/hover");
  });

  it("F-109 initialize 本身也有超时，不会永远挂住", async () => {
    const mgr = mkManager({
      // Answers nothing at all, so the handshake itself is what times out.
      servers: { typescript: { command: process.execPath, args: [FIXTURE, "silent-init"] } },
      initializationTimeoutMs: 300,
    });
    await expect(mgr.forFile(file)).rejects.toThrow(/did not .*initialize/);
  });
});
