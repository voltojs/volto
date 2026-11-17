import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { GatewayProfile } from "@shared/gateway";
import {
  LocalGatewaySupervisor,
  gatewayPortFor,
  parseGatewayListening,
  parseGatewayOpenToken,
  type RunningGateway,
} from "../supervisor";
import type { GatewayRuntime } from "../runtime";

function profile(overrides: Partial<GatewayProfile> = {}): GatewayProfile {
  return { id: "local", label: "Local", kind: "local", url: "", managed: true, ...overrides };
}

function runtimeFor(script: string, env: NodeJS.ProcessEnv = {}): GatewayRuntime {
  return {
    command: process.execPath,
    argsPrefix: [script],
    env: { ...process.env, ELECTRON_RUN_AS_NODE: undefined, ...env },
    label: "test node",
    degraded: false,
  };
}

async function writeScript(dir: string, body: string): Promise<string> {
  const script = path.join(dir, `fake-gateway-${Math.random().toString(16).slice(2)}.mjs`);
  await writeFile(script, body, "utf8");
  return script;
}

describe("gateway output parsing", () => {
  it("reads the listening URL", () => {
    expect(parseGatewayListening("volto gateway 0.2.1 listening on http://127.0.0.1:3100")).toBe(
      "http://127.0.0.1:3100",
    );
  });

  it("ignores unrelated lines", () => {
    expect(parseGatewayListening("Remote mode: native dialogs disabled")).toBeUndefined();
  });

  it("reads the token from the Open URL", () => {
    expect(parseGatewayOpenToken("Open: http://127.0.0.1:3100/?token=abc123")).toBe("abc123");
  });

  it("returns an empty token when the Open URL carries none", () => {
    expect(parseGatewayOpenToken("Open: http://127.0.0.1:3100/")).toBe("");
  });

  it("derives the requested port from the profile URL", () => {
    expect(gatewayPortFor(profile())).toBe(0);
    expect(gatewayPortFor(profile({ url: "http://127.0.0.1:3100" }))).toBe(3100);
  });
});

describe("LocalGatewaySupervisor", () => {
  let dir: string;
  let running: RunningGateway | undefined;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "volto-supervisor-"));
  });

  afterEach(async () => {
    await running?.stop();
    running = undefined;
    await rm(dir, { recursive: true, force: true });
  });

  it("resolves once both contract lines are printed", async () => {
    const script = await writeScript(
      dir,
      `
      console.log("volto gateway 9.9.9 listening on http://127.0.0.1:41234");
      console.log("Open: http://127.0.0.1:41234/?token=token-123");
      setInterval(() => {}, 1000);
      `,
    );
    const supervisor = new LocalGatewaySupervisor({ runtime: async () => runtimeFor(script) });
    running = await supervisor.start(profile());
    expect(running.url).toBe("http://127.0.0.1:41234");
    expect(running.token).toBe("token-123");
    expect(running.degraded).toBe(false);
    expect(running.pid).toBeGreaterThan(0);
  });

  it("passes --port 0 --no-open when the profile has no URL", async () => {
    const argvFile = path.join(dir, "argv.txt");
    const script = await writeScript(
      dir,
      `
      const { writeFileSync } = await import("node:fs");
      writeFileSync(process.env.FAKE_ARGV_FILE, process.argv.slice(2).join(" "));
      console.log("volto gateway 9.9.9 listening on http://127.0.0.1:41235");
      console.log("Open: http://127.0.0.1:41235/?token=t");
      setInterval(() => {}, 1000);
      `,
    );
    const supervisor = new LocalGatewaySupervisor({
      runtime: async () => runtimeFor(script, { FAKE_ARGV_FILE: argvFile }),
    });
    running = await supervisor.start(profile());
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect((await readFile(argvFile, "utf8")).trim()).toBe("--port 0 --no-open");
  });

  it("marks the gateway degraded when the session store falls back", async () => {
    const script = await writeScript(
      dir,
      `
      console.error("volto: WARNING — the sqlite session store at /tmp/x could not be loaded");
      console.error("Sessions are now saved to /tmp/sessions-store");
      setTimeout(() => {
        console.log("volto gateway 9.9.9 listening on http://127.0.0.1:41236");
        console.log("Open: http://127.0.0.1:41236/?token=t");
      }, 30);
      setInterval(() => {}, 1000);
      `,
    );
    const supervisor = new LocalGatewaySupervisor({ runtime: async () => runtimeFor(script) });
    running = await supervisor.start(profile());
    expect(running.degraded).toBe(true);
  });

  it("rejects when the process exits before becoming ready", async () => {
    const script = await writeScript(
      dir,
      `
      console.error("fatal: better-sqlite3 missing");
      process.exit(1);
      `,
    );
    const supervisor = new LocalGatewaySupervisor({ runtime: async () => runtimeFor(script) });
    await expect(supervisor.start(profile())).rejects.toThrow("fatal: better-sqlite3 missing");
  });

  it("rejects when the gateway never prints the contract lines", async () => {
    const script = await writeScript(dir, `setInterval(() => {}, 1000);`);
    const supervisor = new LocalGatewaySupervisor({
      runtime: async () => runtimeFor(script),
      timeoutMs: 250,
    });
    await expect(supervisor.start(profile())).rejects.toThrow("没有启动");
  });

  it("stops the child process and is idempotent", async () => {
    const script = await writeScript(
      dir,
      `
      console.log("volto gateway 9.9.9 listening on http://127.0.0.1:41237");
      console.log("Open: http://127.0.0.1:41237/?token=t");
      setInterval(() => {}, 1000);
      `,
    );
    const supervisor = new LocalGatewaySupervisor({ runtime: async () => runtimeFor(script) });
    const started = await supervisor.start(profile());
    const pid = started.pid;
    await started.stop();
    await started.stop();
    if (pid !== undefined) {
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(() => process.kill(pid, 0)).toThrow();
    }
    running = undefined;
  });
});