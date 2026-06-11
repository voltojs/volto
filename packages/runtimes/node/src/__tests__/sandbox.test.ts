import { describe, it, expect } from "vitest";
import { createNodeSandbox } from "../sandbox.js";

describe("createNodeSandbox", () => {
  describe("basic execution (no isolation)", () => {
    it("runs a command and yields stdout + exit event", async () => {
      const sandbox = createNodeSandbox({
        policy: { backend: "none" },
      });

      const events: Array<{ type: string; data?: string; code?: number }> = [];
      for await (const event of sandbox.run({ command: "echo", args: ["hello"] })) {
        events.push(event);
      }

      const stdout = events.filter((e) => e.type === "stdout").map((e) => e.data).join("");
      expect(stdout.trim()).toBe("hello");

      const exitEvent = events.find((e) => e.type === "exit");
      expect(exitEvent?.code).toBe(0);
    });

    it("returns exit code 1 on command failure", async () => {
      const sandbox = createNodeSandbox({
        policy: { backend: "none" },
      });

      const events: Array<{ type: string; data?: string; code?: number }> = [];
      for await (const event of sandbox.run({ command: "false" })) {
        events.push(event);
      }

      const exitEvent = events.find((e) => e.type === "exit");
      expect(exitEvent?.code).toBe(1);
    });
  });

  describe("timeout enforcement", () => {
    it("kills a long-running command after timeout", async () => {
      const sandbox = createNodeSandbox({
        policy: { backend: "none" },
      });

      const events: Array<{ type: string; data?: string; code?: number }> = [];
      const start = Date.now();
      for await (const event of sandbox.run({
        command: "sleep",
        args: ["10"],
        timeout: 500,
      })) {
        events.push(event);
      }
      const elapsed = Date.now() - start;

      const exitEvent = events.find((e) => e.type === "exit");
      expect(exitEvent?.code).not.toBe(0);
      // Should complete well within 5s (timeout + 2s grace)
      expect(elapsed).toBeLessThan(5000);
    });
  });

  describe("backend detection", () => {
    it("none backend runs without wrapping", async () => {
      const sandbox = createNodeSandbox({
        policy: { backend: "none" },
      });

      const events: Array<{ type: string; code?: number }> = [];
      for await (const event of sandbox.run({ command: "echo", args: ["test"] })) {
        events.push(event);
      }

      const exitEvent = events.find((e) => e.type === "exit");
      expect(exitEvent?.code).toBe(0);
    });
  });

  describe("egress check in sandbox env", () => {
    it("denies egress when host not in allowlist", async () => {
      const sandbox = createNodeSandbox({
        policy: {
          backend: "none",
          egressAllow: ["allowed-host.com"],
        },
      });

      const events: Array<{ type: string; data?: string; code?: number }> = [];
      for await (const event of sandbox.run({
        command: "echo",
        args: ["test"],
        env: { EGRESS_HOST: "evil-host.com" },
      })) {
        events.push(event);
      }

      const stderr = events.filter((e) => e.type === "stderr").map((e) => e.data).join("");
      expect(stderr).toContain("denied");
      expect(events.find((e) => e.type === "exit")?.code).toBe(126);
    });

    it("allows egress when host is in allowlist", async () => {
      const sandbox = createNodeSandbox({
        policy: {
          backend: "none",
          egressAllow: ["allowed-host.com"],
        },
      });

      const events: Array<{ type: string; data?: string; code?: number }> = [];
      for await (const event of sandbox.run({
        command: "echo",
        args: ["ok"],
        env: { EGRESS_HOST: "allowed-host.com" },
      })) {
        events.push(event);
      }

      const exitEvent = events.find((e) => e.type === "exit");
      expect(exitEvent?.code).toBe(0);
    });
  });
});
