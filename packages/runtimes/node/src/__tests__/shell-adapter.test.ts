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

  it("launch() returns a PID and starts the process in background", async () => {
    const shell = createNodeShell();
    const pid = await shell.launch!("echo bg-ok", { cwd: "/tmp" });
    expect(typeof pid).toBe("string");
    expect(Number(pid)).toBeGreaterThan(0);
  });
});
