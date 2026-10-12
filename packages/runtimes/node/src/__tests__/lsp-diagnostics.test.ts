/**
 * Diagnostics four-state tests — F-110 / F-111 / F-112.
 *
 * These drive the REAL fixture child process (`fixtures/lsp-server.mjs`) in
 * its `diagnostics-pull` / `diagnostics-push` / `diagnostics-none` modes; no
 * part of the wire is mocked. `sandbox: { mode: "danger-full-access" }` keeps
 * the suite platform-neutral (confinement has its own suite,
 * `sandboxed-process.test.ts`).
 *
 * The reason this suite exists: an empty diagnostic array is ambiguous. The
 * same `[]` means "the server reported no problems" (push cache hit) and "the
 * server has not reported anything yet" (no source). Rendering both as
 * "no diagnostics" is exactly the false green the report contract removes, so
 * the assertions below pin `source`, not just the array length.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { LspClient, LspDiagnosticReport } from "@volto/tools-code";
import { createNodeFileSystem } from "../filesystem.js";
import { createNodeLspManager } from "../lsp.js";
import type { LspManager, LspManagerOptions } from "../lsp.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE = join(HERE, "fixtures", "lsp-server.mjs");
const uri = (p: string): string => `file://${p}`;

const fixedClock = { now: () => 1_700_000_000_000 };

/**
 * A private temp workspace per test.
 *
 * Deliberately NOT the shared in-repo `.lsp-scratch` tree that
 * `lsp-manager.test.ts` uses: vitest runs test files in parallel, and two
 * suites that `rm -rf` the same directory race each other into `EINVAL`/`ENOENT`
 * on each other's documents. A per-suite temp root makes the two independent.
 */
let workspaceRoot = "";
let realFs: ReturnType<typeof createNodeFileSystem>;
let file = "";
/** Managers created by the current test, disposed (and reaped) afterwards. */
let managers: LspManager[] = [];
let scratchDir = "";
let savedLog: string | undefined;
let savedPid: string | undefined;

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

function sleep(ms: number): Promise<void> {
  return new Promise((done) => setTimeout(done, ms));
}

/**
 * Poll `diagnostics` until the report carries `source`.
 *
 * A push server publishes asynchronously, so the call that sends `didOpen` can
 * legitimately still answer "none". The wait is therefore condition-based
 * rather than a fixed sleep, and it fails loudly instead of asserting on a
 * truncated view.
 */
async function untilSource(
  client: LspClient,
  documentUri: string,
  source: LspDiagnosticReport["source"],
): Promise<LspDiagnosticReport> {
  const deadline = Date.now() + 10_000;
  for (;;) {
    const report = await client.diagnostics(documentUri);
    if (report.source === source) return report;
    if (Date.now() > deadline) {
      throw new Error(`diagnostics source stayed "${report.source}", expected "${source}"`);
    }
    await sleep(10);
  }
}

beforeEach(() => {
  managers = [];
  // The workspace root and the fixture's own log/pid both live in OS temp
  // dirs: nothing tracked is ever written, and no other suite can see them.
  workspaceRoot = mkdtempSync(join(tmpdir(), "volto-lsp-diagnostics-ws-"));
  realFs = createNodeFileSystem({ root: workspaceRoot });
  file = join(workspaceRoot, "diagnostics.ts");
  writeFileSync(file, "// scratch diagnostics\n", "utf-8");

  scratchDir = mkdtempSync(join(tmpdir(), "volto-lsp-diagnostics-"));
  savedLog = process.env["LSP_FIXTURE_LOG"];
  savedPid = process.env["LSP_FIXTURE_PIDFILE"];
  // The sandboxed process spawner rebuilds the child environment from the
  // host's, so pointing the fixture at per-test files is done here.
  process.env["LSP_FIXTURE_LOG"] = join(scratchDir, "fixture.log");
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
  rmSync(workspaceRoot, { recursive: true, force: true });
});

describe("LSP diagnostics four states", () => {
  it("F-110 pull 优先", async () => {
    const client = await mkManager({ mode: "diagnostics-pull" }).forFile(file);
    expect(await client.diagnostics(uri(file))).toMatchObject({ source: "pull" });
  });

  it("F-110 pull 结果按诊断契约归一（数字 severity → 字符串）", async () => {
    writeFileSync(file, "// VOLTO_FIXTURE_DIAGNOSTIC\n", "utf-8");
    const client = await mkManager({ mode: "diagnostics-pull" }).forFile(file);

    const report = await client.diagnostics(uri(file));

    expect(report.source).toBe("pull");
    expect(report.diagnostics).toHaveLength(1);
    expect(report.diagnostics[0]).toMatchObject({
      severity: "error",
      message: "fixture diagnostic",
    });
  });

  it("F-111 pull 不可用时回落到 push 缓存", async () => {
    const client = await mkManager({ mode: "diagnostics-push" }).forFile(file);
    await client.diagnostics(uri(file)); // triggers didOpen; the fixture publishes
    await untilSource(client, uri(file), "push");
    expect(await client.diagnostics(uri(file))).toMatchObject({ source: "push" });
  });

  it("F-111 push 模式上报的真实诊断进入缓存", async () => {
    writeFileSync(file, "// VOLTO_FIXTURE_DIAGNOSTIC\n", "utf-8");
    const client = await mkManager({ mode: "diagnostics-push" }).forFile(file);
    await client.diagnostics(uri(file));

    const report = await untilSource(client, uri(file), "push");

    expect(report.diagnostics).toHaveLength(1);
    expect(report.diagnostics[0]).toMatchObject({
      severity: "error",
      message: "fixture diagnostic",
    });
  });

  it("F-112 尚未上报与零诊断必须是不同的报告", async () => {
    const client = await mkManager({ mode: "diagnostics-none" }).forFile(file);
    expect(await client.diagnostics(uri(file))).toMatchObject({ source: "none", diagnostics: [] });
    // 与"服务器上报了空的诊断数组"区分：source 不同
  });

  it("F-112 服务器上报了空数组（push）不与尚未上报（none）混同", async () => {
    const pushed = await mkManager({ mode: "diagnostics-push" }).forFile(file);
    await pushed.diagnostics(uri(file));

    // Same empty array as the "none" case below, different provenance.
    expect(await untilSource(pushed, uri(file), "push")).toMatchObject({
      source: "push",
      diagnostics: [],
    });

    const none = await mkManager({ mode: "diagnostics-none" }).forFile(file);
    expect(await none.diagnostics(uri(file))).toMatchObject({ source: "none", diagnostics: [] });
  });
});
