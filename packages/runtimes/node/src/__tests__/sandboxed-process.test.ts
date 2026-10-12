import { it, expect } from "vitest";
const itDarwin = process.platform === "darwin" ? it : it.skip;   // 平台不匹配显式 skip，不得异地假绿
const itLinux = process.platform === "linux" ? it : it.skip;
import { createSandboxedProcessSpawner, type SandboxedProcess } from "../sandbox.js";
import { tmpdir } from "node:os"; import { join } from "node:path"; import { mkdtempSync, existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";

// ── Local helpers (not part of the production surface) ──

// A host without bwrap is an infrastructure gap, not a denial to assert: the
// bwrap denial case below skips explicitly there (same pattern as
// sandbox.test.ts) instead of passing on the absence of output.
const hasBwrap = (() => {
  try {
    execFileSync("which", ["bwrap"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
})();
const itLinuxBwrap = process.platform === "linux" && hasBwrap ? it : it.skip;

/** Poll until `pred()` holds, or fail the test after `timeoutMs`. */
async function until(pred: () => boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!pred()) {
    if (Date.now() > deadline) throw new Error("until(): condition not met before timeout");
    await new Promise((r) => setTimeout(r, 10));
  }
}

interface Collected {
  pid?: number;
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
}

/** Wait for the process to exit, collecting both output streams verbatim. */
function collect(p: SandboxedProcess): Promise<Collected> {
  return new Promise((resolve, reject) => {
    let out = "";
    let err = "";
    p.stdout.on("data", (c: Buffer) => { out += c.toString(); });
    p.stderr.on("data", (c: Buffer) => { err += c.toString(); });
    p.onError((e) => reject(e));
    p.onExit((code, signal) => resolve({ pid: p.pid, code, signal, stdout: out, stderr: err }));
  });
}

/** Wait for the process to exit and return its stdout verbatim. */
async function stdout(p: SandboxedProcess): Promise<string> {
  return (await collect(p)).stdout;
}

/** Profile files the seatbelt spawner writes for confined children. */
function sandboxProfiles(): Set<string> {
  try { return new Set(readdirSync(tmpdir()).filter((f) => f.startsWith("volto-sandbox-"))); }
  catch { return new Set(); }
}

/**
 * Wait until no NEW `volto-sandbox-*.sb` profile file is left in tmpdir.
 *
 * The spawner unlinks its profile from the child's `exit` handler, which runs
 * asynchronously — a test that stopped at "the output arrived" would leave a
 * file behind and leak it into whatever test file this worker runs next (the
 * session suite counts profiles in the same tmpdir and fails on strays).
 */
async function untilNoNewProfiles(before: Set<string>): Promise<void> {
  await until(() => {
    for (const f of sandboxProfiles()) if (!before.has(f)) return false;
    return true;
  });
}

/**
 * Reap a process whose output has already been collected: kill it, wait for
 * the pid to disappear, then wait for its sandbox profile file to be unlinked.
 */
async function reap(p: SandboxedProcess, collected: Collected, before: Set<string>): Promise<void> {
  if (collected.pid !== undefined) {
    try {
      process.kill(collected.pid, 0);
      p.kill();
      await until(() => {
        try { process.kill(collected.pid!, 0); return false; } catch { return true; }
      });
    } catch { /* already gone */ }
  }
  await untilNoNewProfiles(before);
}

it("F-105 双向管道往返可用", async () => {
  const spawnUnder = createSandboxedProcessSpawner({ mode: "danger-full-access" })!;
  const p = spawnUnder({ command: process.execPath, args: ["-e", 'process.stdin.pipe(process.stdout)'], cwd: process.cwd() });
  let out = ""; p.stdout.on("data", (c) => { out += c.toString(); });
  const exit = new Promise<void>((resolve) => p.onExit(() => resolve()));
  p.stdin.write("ping\n");
  await until(() => out.includes("ping"));
  p.kill();
  await exit;
});

it("F-102 无后端且 failIfUnavailable 时构建期抛错", () => {
  // 用 backend: "none" 强制走到无后端分支，断言错误消息含 "Refusing to run unconfined"
  expect(() => createSandboxedProcessSpawner({ mode: "workspace-write", backend: "none" })).toThrow(/Refusing to run unconfined/);
});

it("F-102 failIfUnavailable:false 返回 undefined 而不是无沙箱直通", () => {
  expect(createSandboxedProcessSpawner({ mode: "workspace-write", backend: "none", failIfUnavailable: false })).toBeUndefined();
});

itDarwin("F-101 seatbelt 下工作区外写被拒，且断言该后端方言", async () => {
  const dir = mkdtempSync(join(tmpdir(), "volto-proc-"));
  const target = "/Users/Shared/volto-proc-should-not-exist.txt";
  const profilesBefore = sandboxProfiles();
  const spawnUnder = createSandboxedProcessSpawner({ mode: "workspace-write", writableRoots: [dir] })!;
  const p = spawnUnder({ command: "/bin/sh", args: ["-c", `echo x > ${target}`], cwd: dir });
  const result = await collect(p);
  try {
    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain("Operation not permitted");   // Seatbelt 方言，不是"输出为空"
    expect(existsSync(target)).toBe(false);
  } finally {
    await reap(p, result, profilesBefore);
  }
});

// A host without bwrap has no bwrap dialect to assert, so the Linux case skips
// explicitly there rather than passing on the absence of output.
itLinuxBwrap("F-101 bwrap 下工作区外写被拒，且断言该后端方言", async () => {
  const dir = mkdtempSync(join(tmpdir(), "volto-proc-"));
  // A temp dir outside the single writable root: it exists, so the denial can
  // only come from the read-only bind, not from a missing parent.
  const outside = mkdtempSync(join(tmpdir(), "volto-proc-out-"));
  const target = join(outside, "should-not-exist.txt");
  const profilesBefore = sandboxProfiles();
  const spawnUnder = createSandboxedProcessSpawner({ mode: "workspace-write", writableRoots: [dir] })!;
  const p = spawnUnder({ command: "/bin/sh", args: ["-c", `echo x > ${target}`], cwd: dir });
  const result = await collect(p);
  try {
    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain("Read-only file system");   // bwrap 方言，不是"输出为空"
    expect(existsSync(target)).toBe(false);
  } finally {
    await reap(p, result, profilesBefore);
  }
});

itDarwin("F-101 kill() 回收内层进程，而不只是 sandbox-exec 包装进程", async () => {
  // `sandbox-exec` does not exec-replace itself when the wrapped command
  // forks: `sh -c 'a && b'` leaves the node process as a GRANDCHILD with its
  // own pid. Signalling only the wrapper pid leaves it running, so this is
  // the case that proves the launch uses its own process group and kill()
  // signals the group.
  const dir = mkdtempSync(join(tmpdir(), "volto-proc-kill-"));
  const pidFile = join(dir, "inner.pid");
  const innerScript = join(dir, "inner.mjs");
  writeFileSync(innerScript,
    `import { writeFileSync } from "node:fs";\n` +
    `writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));\n` +
    `setInterval(() => {}, 1000);\n`);
  const alive = (pid: number): boolean => {
    try { process.kill(pid, 0); return true; } catch { return false; }
  };

  const profilesBefore = sandboxProfiles();
  const spawnUnder = createSandboxedProcessSpawner({ mode: "workspace-write", writableRoots: [dir] })!;
  // Two commands after `-c`: the shell forks instead of exec-optimizing.
  const p = spawnUnder({
    command: "/bin/sh",
    args: ["-c", `echo forked && ${process.execPath} ${innerScript}`],
    cwd: dir,
  });
  try {
    await until(() => existsSync(pidFile));
    const innerPid = Number(readFileSync(pidFile, "utf-8"));
    expect(innerPid).not.toBe(p.pid);   // a real grandchild, not the wrapper
    expect(alive(innerPid)).toBe(true);

    p.kill();
    await until(() => !alive(innerPid));
    expect(alive(innerPid)).toBe(false);
  } finally {
    // Never leak a stray process or its profile file if an assertion failed.
    try { p.kill("SIGKILL"); } catch { /* already gone */ }
    await untilNoNewProfiles(profilesBefore);
  }
});

it("F-103 enforcement 是运行时事实", async () => {
  const passthrough = createSandboxedProcessSpawner({ mode: "danger-full-access" })!;
  const p = passthrough({ command: process.execPath, args: ["-e", ""], cwd: process.cwd() });
  const exit = new Promise<Collected>((resolve) => p.onExit((code, signal) => resolve({ pid: p.pid, code, signal, stdout: "", stderr: "" })));
  expect(p.enforcement).toBe("none");
  // Reap it: a passthrough child has no wrapper to hold it, but leaving it
  // alive would still straddle the end of this test file.
  await reap(p, await exit, new Set());
});

it("F-103 子进程启动失败经 onError 上报，不冒泡成未捕获异常", async () => {
  const spawnUnder = createSandboxedProcessSpawner({ mode: "danger-full-access" })!;
  // spawn() for a non-existent binary emits 'error' asynchronously; an
  // unconsumed 'error' event on a ChildProcess is an uncaught exception in the
  // host process, which is exactly what this must not become.
  const p = spawnUnder({ command: "volto-definitely-not-a-real-binary", args: [], cwd: process.cwd() });
  const outcome = new Promise<"error" | "exit">((resolve) => {
    p.onError(() => resolve("error"));
    p.onExit(() => resolve("exit"));
  });
  await new Promise((r) => setTimeout(r, 300));
  expect(await outcome).toBe("error");
});

itLinux("F-102 选中 bwrap 后端但 runner 缺失时构建期抛错", () => {  // bwrap is Linux-only. An injected name that PATH cannot resolve forces the
  // "backend selected, runner missing" branch — the same branch a Linux host
  // without bubblewrap hits — and it must refuse at construction, never
  // quietly hand back a spawner.
  expect(() => createSandboxedProcessSpawner({
    mode: "workspace-write",
    backend: "bubblewrap",
    bwrapBinary: "volto-definitely-not-a-real-bwrap",
  })).toThrow(/bwrap/);
});

it("F-104 env 剥离在子进程内生效", async () => {
  process.env.VOLTO_TEST_SECRET = "leak-me";
  const spawnUnder = createSandboxedProcessSpawner({ mode: "danger-full-access", strippedEnvVars: ["VOLTO_TEST_SECRET"] })!;
  const p = spawnUnder({ command: process.execPath, args: ["-e", "process.stdout.write(process.env.VOLTO_TEST_SECRET ?? 'GONE')"], cwd: process.cwd() });
  expect(await stdout(p)).toBe("GONE");
});
