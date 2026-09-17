import { describe, it, expect } from "vitest";
import { createNodeShell } from "../shell.js";
import type { Shell } from "@volto/core";

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

  it("respects timeout", async () => {
    const shell = createNodeShell();
    const start = Date.now();
    const events: Array<{ type: string; data?: string; code?: number }> = [];
    for await (const event of shell.exec("sleep 10", { timeout: 500 })) {
      events.push(event);
    }
    const elapsed = Date.now() - start;
    expect(elapsed).toBeLessThan(3000);
    expect(events.some((e) => e.type === "exit")).toBe(true);
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
