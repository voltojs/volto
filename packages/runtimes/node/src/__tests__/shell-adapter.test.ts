import { describe, it, expect } from "vitest";
import { createNodeShell } from "../shell.js";

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
    // Wait for the child to finish so the buffer is complete.
    await new Promise((r) => setTimeout(r, 300));
    const out = await shell.readProcessOutput!(id);
    expect(out.text).toContain("bg-readable");
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
