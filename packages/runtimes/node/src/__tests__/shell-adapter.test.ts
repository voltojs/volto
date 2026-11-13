import { describe, it, expect } from "vitest";
import { createNodeShell } from "../shell.js";
import type { Shell, ShellEvent } from "@voltojs/core";

/**
 * Poll the process buffer until `needle` shows up. A fixed sleep asserts on
 * a wall-clock guess rather than on the condition the test cares about, and
 * fails whenever fork/exec + the child's write + the parent's `data` event
 * take longer than the guess — which is exactly what happens when the whole
 * repo's typecheck/lint/test run in parallel.
 *
 * Reading without a cursor always returns the full retained buffer, so
 * polling this way cannot consume the output it is waiting for.
 */
async function waitForOutput(
  shell: Shell,
  id: string,
  needle: string,
  timeoutMs = 15_000,
): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const out = await shell.readProcessOutput!(id);
    if (out.text.includes(needle)) return out.text;
    if (Date.now() > deadline) {
      throw new Error(
        `timed out after ${timeoutMs}ms waiting for ${JSON.stringify(needle)}; ` +
          `buffer so far: ${JSON.stringify(out.text.slice(0, 200))}`,
      );
    }
    await new Promise((r) => setTimeout(r, 25));
  }
}

describe("Node Shell adapter", () => {
  it("executes a command and yields stdout, stderr, and exit events", async () => {
    const shell = createNodeShell();
    const events: Array<{ type: string; data?: string; code?: number }> = [];
    for await (const event of shell.exec("echo hello")) {
      events.push(event);
    }
    expect(events.some((e) => e.type === "stdout" && e.data?.includes("hello"))).toBe(true);
    expect(events.some((e) => e.type === "exit")).toBe(true);
  });

  it("yields stderr events for failing commands", async () => {
    const shell = createNodeShell();
    const events: Array<{ type: string; data?: string; code?: number }> = [];
    for await (const event of shell.exec("node -e \"process.stderr.write('err')\"")) {
      events.push(event);
    }
    expect(events.some((e) => e.type === "stderr" && e.data?.includes("err"))).toBe(true);
  });

  it("respects custom cwd", async () => {
    const shell = createNodeShell();
    const events: Array<{ type: string; data?: string; code?: number }> = [];
    for await (const event of shell.exec("pwd", { cwd: "/tmp" })) {
      events.push(event);
    }
    const stdout = events.filter((e) => e.type === "stdout").map((e) => e.data).join("");
    expect(stdout.trim()).toMatch(/\/tmp$/);
  });

  it("respects timeout and marks the exit event timedOut", async () => {
    const shell = createNodeShell();
    const start = Date.now();
    const events: ShellEvent[] = [];
    for await (const event of shell.exec("sleep 10", { timeout: 500 })) {
      events.push(event);
    }
    const elapsed = Date.now() - start;
    expect(elapsed).toBeLessThan(3000);
    const exitEvent = events.find((e) => e.type === "exit");
    expect(exitEvent).toBeDefined();
    // Review Focus 2: a real subprocess killed by the adapter's own timeout
    // timer must carry the timeout identity (SIGTERM → close code null → 1
    // is otherwise indistinguishable from an ordinary failure).
    expect((exitEvent as Extract<ShellEvent, { type: "exit" }>).timedOut).toBe(true);
  });

  it("timeout kills the command the shell forked, not just the shell", async () => {
    // `shell: true` makes the command a grandchild: signalling only the shell
    // leaves it holding the stdout pipe, so `close` — and this iteration —
    // would wait out the command's own run time instead of the 500 ms timeout.
    // The trailing `&& true` is what forces the fork: `/bin/sh` exec-optimizes
    // a single simple command (the shell then IS the command, nothing to leak).
    const shell = createNodeShell();
    const script = "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000);";
    const start = Date.now();
    const events: ShellEvent[] = [];
    for await (const event of shell.exec(`node -e "${script}" && true`, { timeout: 500 })) {
      events.push(event);
    }
    const elapsed = Date.now() - start;
    const exitEvent = events.find((e) => e.type === "exit") as Extract<ShellEvent, { type: "exit" }> | undefined;
    expect(exitEvent?.timedOut).toBe(true);
    // SIGTERM (ignored) → SIGKILL after the 2 s grace, not the command's own run time.
    expect(elapsed).toBeLessThan(5000);
  });

  it("does not carry timedOut on an ordinary exit (wire shape unchanged)", async () => {
    const shell = createNodeShell();
    const events: ShellEvent[] = [];
    for await (const event of shell.exec("exit 0")) {
      events.push(event);
    }
    const exitEvent = events.find((e) => e.type === "exit");
    // Review Focus 1: exact-shape pin — ordinary exits keep the pre-T9 wire
    // shape byte for byte; no timedOut key may appear.
    expect(exitEvent).toEqual({ type: "exit", code: 0 });
  });

  it("does not mark external abortSignal termination as timedOut", async () => {
    const shell = createNodeShell();
    const controller = new AbortController();
    const events: ShellEvent[] = [];
    const done = (async () => {
      for await (const event of shell.exec(
        "node -e \"process.stdout.write('started'); setTimeout(() => {}, 10000)\"",
        { abortSignal: controller.signal },
      )) {
        events.push(event);
      }
    })();
    // Abort mid-stream: once stdout has arrived but the child is still alive.
    const deadline = Date.now() + 10_000;
    while (!events.some((e) => e.type === "stdout" && e.data?.includes("started"))) {
      if (Date.now() > deadline) throw new Error("never saw stdout before abort");
      await new Promise((r) => setTimeout(r, 25));
    }
    controller.abort();
    await done;
    const exitEvent = events.find((e) => e.type === "exit");
    // Spec §6: external abort is cancellation, not timeout — no timedOut key.
    expect(exitEvent).toBeDefined();
    expect(exitEvent).not.toHaveProperty("timedOut");
  });

  it("launch() returns a registry id and starts the process in background", async () => {
    const shell = createNodeShell();
    const id = await shell.launch!("echo bg-ok", { cwd: "/tmp" });
    expect(typeof id).toBe("string");
    expect(id).toMatch(/^bg-/);
  });

  it("launch() consumes stdout and exposes it via readProcessOutput", async () => {
    const shell = createNodeShell();
    const id = await shell.launch!("echo bg-readable");
    expect(await waitForOutput(shell, id, "bg-readable")).toContain("bg-readable");
  });

  it("launch() keeps draining stdout a child writes well after startup", async () => {
    // Proves the wait above is condition-based rather than passing because
    // the output happened to be there already: this output cannot exist
    // until a second has gone by.
    const shell = createNodeShell();
    const id = await shell.launch!("sleep 1; echo late-output");
    expect(await waitForOutput(shell, id, "late-output")).toContain("late-output");
  });

  it("exposes listProcesses / killProcess / disposeProcesses", async () => {
    const shell = createNodeShell();
    const id = await shell.launch!("sleep 20");
    expect(shell.listProcesses!().some((p) => p.id === id && p.running)).toBe(true);
    await shell.killProcess!(id);
    expect(shell.listProcesses!().find((p) => p.id === id)!.running).toBe(false);
    await shell.disposeProcesses!();
  });
});
