import { it, expect } from "vitest";
const itDarwin = process.platform === "darwin" ? it : it.skip;   // Explicit skip off-platform; never pass abroad.
const itLinux = process.platform === "linux" ? it : it.skip;
import { createSandboxedProcessSpawner, probeBinary, type SandboxBackend, type SandboxedProcess } from "../sandbox.js";
import { tmpdir } from "node:os"; import { join } from "node:path"; import { mkdtempSync, existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";

// ── Local helpers (not part of the production surface) ──

// A host without bwrap is an infrastructure gap, not a denial to assert: the
// real-bwrap denial case skips there, so a missing runner can never pass as a
// denial. Reuse the exported probe rather than re-implementing `which`.
const hasBwrap = probeBinary("bwrap");

// The read-only smoke case below needs a backend that can actually confine
// THIS host: seatbelt on darwin, bwrap on linux. Where neither runner exists
// there is nothing to smoke — the case is reported as skipped rather than
// passing on the strength of an unconfined fallback.
const readOnlyBackend: SandboxBackend | undefined =
  process.platform === "darwin" && probeBinary("sandbox-exec")
    ? "seatbelt"
    : process.platform === "linux" && hasBwrap
      ? "bubblewrap"
      : undefined;

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

/** Resolve once `stream` has reported every chunk (and a terminal event). */
function streamEnded(stream: NodeJS.ReadableStream): Promise<void> {
  return new Promise((resolve) => {
    stream.on("end", resolve);
    stream.on("close", resolve);
    stream.on("error", resolve);
  });
}

/**
 * Wait for the child to exit AND for both output streams to reach end-of-data,
 * collecting everything verbatim — or reject as soon as `onError` fires.
 *
 * Resolving on `exit` alone is not enough: Node may emit the exit event before
 * stdio has drained, which would truncate the very stderr the denial
 * assertions read. Rejecting on `onError` is equally required: an
 * `unavailableProcess` (profile-write failure, synchronous spawn throw) reports
 * its failure there and NEVER emits an exit, so waiting for exit alone would
 * sit out the timeout instead of failing on the error. Flowing mode turns on
 * `end` for these listeners.
 */
function collect(p: SandboxedProcess): Promise<Collected> {
  return new Promise((resolve, reject) => {
    let out = "";
    let err = "";
    let settled = false;
    const settle = (fn: () => void): void => {
      if (settled) return;
      settled = true;
      fn();
    };
    p.stdout.on("data", (c: Buffer) => { out += c.toString(); });
    p.stderr.on("data", (c: Buffer) => { err += c.toString(); });
    p.onError((e) => settle(() => reject(e)));
    void Promise.all([
      streamEnded(p.stdout),
      streamEnded(p.stderr),
      new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((res) => {
        p.onExit((code, signal) => res({ code, signal }));
      }),
    ]).then(([, , exit]) => {
      settle(() => resolve({ pid: p.pid, code: exit.code, signal: exit.signal, stdout: out, stderr: err }));
    });
  });
}

/** Wait for the process to exit and return its stdout verbatim. */
async function stdout(p: SandboxedProcess): Promise<string> {
  return (await collect(p)).stdout;
}

/** Profile files the seatbelt process spawner writes for confined children. */
function sandboxProfiles(): Set<string> {
  try { return new Set(readdirSync(tmpdir()).filter((f) => f.startsWith("volto-proc-sandbox-"))); }
  catch { return new Set(); }
}

/**
 * Wait until no NEW `volto-proc-sandbox-*.sb` profile file is left in tmpdir.
 *
 * The spawner unlinks its profile from the child's `exit` handler, which runs
 * asynchronously — a test that stopped at "the output arrived" would leave a
 * file behind for the rest of this worker's run.
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

it("F-105 pipes work in both directions", async () => {
  const spawnUnder = createSandboxedProcessSpawner({ mode: "danger-full-access" })!;
  const p = spawnUnder({ command: process.execPath, args: ["-e", "process.stdin.pipe(process.stdout)"], cwd: process.cwd() });
  let out = ""; p.stdout.on("data", (c: Buffer) => { out += c.toString(); });
  const exit = new Promise<void>((resolve) => p.onExit(() => resolve()));
  p.stdin.write("ping\n");
  await until(() => out.includes("ping"));
  p.kill();
  await exit;
});

it("F-102 refuses at construction when no backend exists and failIfUnavailable holds", () => {
  // backend: "none" forces the no-backend branch; the message must say refuse.
  expect(() => createSandboxedProcessSpawner({ mode: "workspace-write", backend: "none" })).toThrow(/Refusing to run unconfined/);
  // The opt-out must not read as "you get an unconfined process" — this
  // spawner returns undefined instead, and the text has to say so.
  expect(() => createSandboxedProcessSpawner({ mode: "workspace-write", backend: "none" }))
    .toThrow(/return undefined/);
});

it("F-102 failIfUnavailable:false returns undefined rather than an unconfined passthrough", () => {
  expect(createSandboxedProcessSpawner({ mode: "workspace-write", backend: "none", failIfUnavailable: false })).toBeUndefined();
});

it("F-102 refuses a host whitelist it cannot enforce", () => {
  // No egress proxy and the backend's network rule is on/off only, so a
  // non-empty allowedHosts would be silently ignored. Refuse instead. The
  // rejection does not depend on a backend being present.
  expect(() => createSandboxedProcessSpawner({
    mode: "workspace-write",
    backend: "seatbelt",
    network: { enabled: true, allowedHosts: ["example.com"] },
  })).toThrow(/host whitelist/);
});

it("F-102 accepts enabled egress with an empty or absent host whitelist", () => {
  // Nothing to enforce: egress is on/off, and both forms say "allow egress".
  expect(createSandboxedProcessSpawner({
    mode: "danger-full-access",
    network: { enabled: true, allowedHosts: [] },
  })).toBeTypeOf("function");
  expect(createSandboxedProcessSpawner({
    mode: "danger-full-access",
    network: { enabled: true },
  })).toBeTypeOf("function");
});

itDarwin("F-101 seatbelt denies a write outside the writable roots, asserting that backend's dialect", async () => {
  const dir = mkdtempSync(join(tmpdir(), "volto-proc-"));
  const target = "/Users/Shared/volto-proc-should-not-exist.txt";
  const profilesBefore = sandboxProfiles();
  const spawnUnder = createSandboxedProcessSpawner({ mode: "workspace-write", writableRoots: [dir] })!;
  const p = spawnUnder({ command: "/bin/sh", args: ["-c", `echo x > ${target}`], cwd: dir });
  const result = await collect(p);
  try {
    expect(result.code).not.toBe(0);
    // Seatbelt's denial dialect — never "the output was empty".
    expect(result.stderr).toContain("Operation not permitted");
    expect(existsSync(target)).toBe(false);
  } finally {
    await reap(p, result, profilesBefore);
  }
});

itLinux("F-101 bwrap denies a write outside the writable roots, asserting that backend's dialect", async () => {
  // No bwrap means no bwrap dialect to assert — skip rather than pass on the
  // absence of output.
  if (!hasBwrap) return;
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
    // bwrap's denial dialect — never "the output was empty".
    expect(result.stderr).toContain("Read-only file system");
    expect(existsSync(target)).toBe(false);
  } finally {
    await reap(p, result, profilesBefore);
  }
});

itLinux("F-101 bwrap read-only mode denies a write into a configured writableRoot, asserting that backend's dialect", async () => {
  // The sibling case above proves "outside the roots is denied" in
  // workspace-write. THIS case is the one the read-only fix targets: the
  // gateway hands a read-only session the same `writableRoots` it hands a
  // workspace-write one, and the mode — not the field — must decide. Before
  // the fix bwrap emitted `--bind <dir> <dir>` here and this write succeeded.
  // No bwrap means no bwrap dialect to assert — skip rather than pass on the
  // absence of output.
  if (!hasBwrap) return;
  const dir = mkdtempSync(join(tmpdir(), "volto-proc-ro-"));
  const target = join(dir, "should-not-exist.txt");
  const profilesBefore = sandboxProfiles();
  const spawnUnder = createSandboxedProcessSpawner({
    mode: "read-only",
    backend: "bubblewrap",       // the dialect asserted below is bwrap's own
    writableRoots: [dir],
  })!;
  const p = spawnUnder({ command: "/bin/sh", args: ["-c", `echo x > ${target}`], cwd: dir });
  const result = await collect(p);
  try {
    expect(result.code).not.toBe(0);
    // bwrap's denial dialect — never "the output was empty".
    expect(result.stderr).toContain("Read-only file system");
    expect(existsSync(target)).toBe(false);
  } finally {
    await reap(p, result, profilesBefore);
  }
});

it.skipIf(readOnlyBackend === undefined)(
  "read-only: a confined child still starts, answers over the pipes, and exits cleanly",
  async () => {
    // Cross-platform smoke for the path this fix touches: a read-only session
    // must still be able to RUN a child (the LSP language server), not merely
    // be denied writes. Runs here under seatbelt on darwin; on a host with no
    // usable backend it is reported as skipped, never passed.
    const dir = mkdtempSync(join(tmpdir(), "volto-proc-ro-smoke-"));
    const spawnUnder = createSandboxedProcessSpawner({
      mode: "read-only",
      backend: readOnlyBackend,
      // Supplied on purpose: the same roots the gateway gives a read-only
      // session. They must not become writable, and must not break startup.
      writableRoots: [dir],
    });
    expect(spawnUnder).toBeTypeOf("function");
    const p = spawnUnder!({ command: "/bin/sh", args: ["-c", "cat"], cwd: dir });
    // Enforcement is a runtime fact, not a config claim.
    expect(p.enforcement).toBe("full");
    expect(p.pid).toBeTypeOf("number");
    // Answers over both pipes: stdin in, the same bytes out on stdout.
    p.stdin.end("ro-pipe-ok\n");
    const result = await collect(p);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("ro-pipe-ok");
  },
);

itDarwin("F-101 kill() reaps the inner process, not just the sandbox-exec wrapper", async () => {
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

it("F-103 enforcement is a runtime fact", async () => {
  const passthrough = createSandboxedProcessSpawner({ mode: "danger-full-access" })!;
  const p = passthrough({ command: process.execPath, args: ["-e", ""], cwd: process.cwd() });
  const exit = new Promise<Collected>((resolve) => p.onExit((code, signal) => resolve({ pid: p.pid, code, signal, stdout: "", stderr: "" })));
  expect(p.enforcement).toBe("none");
  // Reap it: a passthrough child has no wrapper to hold it, but leaving it
  // alive would still straddle the end of this test file.
  await reap(p, await exit, new Set());
});

it("F-103 a child that fails to start surfaces through onError, never as an uncaught exception", async () => {
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

it("F-103 collect() rejects on a spawn failure instead of waiting for an exit that never comes", async () => {
  // A failed spawn reports through onError and never emits `exit`. The shared
  // collect() helper must fail on that error rather than sit out its timeout:
  // the denial assertions downstream read its stderr, so a false "no output"
  // result is the failure mode to avoid. The 4s guard makes a regression show
  // up as a clear assertion failure rather than a whole-suite timeout.
  const spawnUnder = createSandboxedProcessSpawner({ mode: "danger-full-access" })!;
  const p = spawnUnder({ command: "volto-definitely-not-a-real-binary", args: [], cwd: process.cwd() });
  const guard = new Promise<never>((_, rej) =>
    setTimeout(() => rej(new Error("collect() did not settle within 4s")), 4_000));
  await expect(Promise.race([collect(p), guard])).rejects.toThrow(/ENOENT/);
});

it("F-102 a selected backend whose runner binary is missing refuses at construction", () => {
  // The injected name cannot resolve on PATH, so this exercises the "backend
  // selected, runner missing" branch without needing a real bwrap — it must
  // refuse at construction, never quietly hand back a spawner.
  expect(() => createSandboxedProcessSpawner({
    mode: "workspace-write",
    backend: "bubblewrap",
    bwrapBinary: "volto-definitely-not-a-real-bwrap",
  })).toThrow(/bwrap/);
});

it("F-104 env stripping takes effect inside the child", async () => {
  process.env.VOLTO_TEST_SECRET = "leak-me";
  try {
    const spawnUnder = createSandboxedProcessSpawner({ mode: "danger-full-access", strippedEnvVars: ["VOLTO_TEST_SECRET"] })!;
    const p = spawnUnder({ command: process.execPath, args: ["-e", "process.stdout.write(process.env.VOLTO_TEST_SECRET ?? 'GONE')"], cwd: process.cwd() });
    expect(await stdout(p)).toBe("GONE");
  } finally {
    delete process.env.VOLTO_TEST_SECRET;   // never leak the fixture into sibling tests
  }
});
