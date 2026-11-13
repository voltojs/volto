import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

// The CLI is exercised as a subprocess against its built entry point — the
// same thing `pnpm --filter @voltojs/eval replay` runs. The build is part of
// the test setup so a stale dist cannot produce a green result.
const PKG_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const CLI = join(PKG_DIR, "dist/cli.js");

function buildCli(): void {
  const tsc = createRequire(import.meta.url).resolve("typescript/bin/tsc");
  execFileSync(process.execPath, [tsc, "--build"], { cwd: PKG_DIR, stdio: "pipe" });
}

interface RunResult {
  status: number;
  stdout: string;
  stderr: string;
}

function runCli(args: string[]): RunResult {
  try {
    const stdout = execFileSync(process.execPath, [CLI, ...args], { encoding: "utf8" });
    return { status: 0, stdout, stderr: "" };
  } catch (err) {
    const e = err as { status?: number; stdout?: string; stderr?: string };
    return { status: e.status ?? -1, stdout: e.stdout ?? "", stderr: e.stderr ?? "" };
  }
}

/** A minimal trajectory whose expected entries are deliberately stale. */
const STALE_TRAJECTORY = {
  name: "fixture-stale",
  stepContext: { model: "fixture-model", maxTokens: 100, tools: [] },
  metadata: { category: "smoke" },
  inputs: [
    { type: "user_message", content: "hello" },
    { type: "model_done", stopReason: "end_turn" },
  ],
  expected: [
    { state: { status: "done" }, effects: ["nope"] },
    { state: { status: "done" }, effects: ["nope"] },
  ],
};

describe("cli", () => {
  let dir: string;
  let file: string;

  beforeAll(() => {
    buildCli();
    dir = mkdtempSync(join(tmpdir(), "volto-eval-cli-"));
    file = join(dir, "fixture-stale.json");
    writeFileSync(file, `${JSON.stringify(STALE_TRAJECTORY, null, 2)}\n`);
  });

  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("replay (default mode) fails on a stale fixture and never rewrites it", () => {
    expect(existsSync(CLI)).toBe(true);
    const before = readFileSync(file, "utf8");

    const res = runCli(["--dir", dir]);
    expect(res.status).toBe(1);
    expect(res.stdout).toContain("[FAIL] fixture-stale");
    expect(readFileSync(file, "utf8")).toBe(before);
  });

  it("--record rewrites only `expected` and keeps formatting", () => {
    const original = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;

    const res = runCli(["--dir", dir, "--record"]);
    expect(res.status).toBe(0);
    expect(res.stdout).toContain("[RECORDED] fixture-stale (fixture-stale.json) — 2 steps");
    expect(res.stdout).toContain("1/1 trajectories recorded, 2 steps total.");

    const text = readFileSync(file, "utf8");
    expect(text.endsWith("}\n")).toBe(true);
    expect(text).toBe(`${JSON.stringify(JSON.parse(text), null, 2)}\n`);

    const rewritten = JSON.parse(text) as typeof original;
    const { expected: _expected, ...restOriginal } = original;
    const { expected: recorded, ...restRewritten } = rewritten;
    // Everything outside `expected` is preserved verbatim, key order included.
    expect(JSON.stringify(restRewritten)).toBe(JSON.stringify(restOriginal));
    expect(JSON.stringify(Object.keys(rewritten))).toBe(
      JSON.stringify(["name", "stepContext", "metadata", "inputs", "expected"]),
    );

    const steps = recorded as Array<{
      state: { status: string };
      effects: string[];
      fullState: Record<string, unknown>;
      fullEffects: Array<{ type: string }>;
    }>;
    expect(steps).toHaveLength(2);
    expect(steps[0]!.state).toEqual({ status: "calling_model" });
    expect(steps[1]!.state).toEqual({ status: "done" });
    expect(steps[0]!.effects).toEqual(steps[0]!.fullEffects.map((e) => e.type));
    expect(steps[0]!.fullState.status).toBe("calling_model");
  });

  it("--record is idempotent and the strict replay gate then passes", () => {
    const once = readFileSync(file, "utf8");

    const second = runCli(["--dir", dir, "--record"]);
    expect(second.status).toBe(0);
    expect(readFileSync(file, "utf8")).toBe(once);

    const replay = runCli(["--dir", dir]);
    expect(replay.status).toBe(0);
    expect(replay.stdout).toContain("[PASS] fixture-stale");
    expect(replay.stdout).toContain("1/1 trajectories, 2 steps total, strict mode, full (state, effects).");
  });

  it("--record refuses --loose", () => {
    const res = runCli(["--dir", dir, "--record", "--loose"]);
    expect(res.status).toBe(2);
    expect(res.stderr).toContain("cannot be combined with --loose");
  });

  it("documents --record in --help", () => {
    const res = runCli(["--help"]);
    expect(res.status).toBe(0);
    expect(res.stdout).toContain("--record");
  });
});