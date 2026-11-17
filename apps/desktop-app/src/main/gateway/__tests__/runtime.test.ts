import { describe, expect, it } from "vitest";

import {
  buildRuntime,
  gatewayEntryCandidates,
  parseNodeMajor,
  pathEntries,
  resolveGatewayRuntime,
  type RuntimeResolveOptions,
} from "../runtime";

const ENTRY = "/repo/apps/gateway/dist/bin.js";

function baseOptions(overrides: Partial<RuntimeResolveOptions> = {}): RuntimeResolveOptions {
  return {
    env: {},
    isPackaged: false,
    appPath: "/repo/apps/desktop-app",
    resourcesPath: "/repo/Resources",
    execPath: "/repo/node_modules/electron/dist/Electron",
    pathEnv: "/usr/local/bin:/usr/bin",
    fileExists: async (filePath) => filePath === ENTRY || filePath === "/usr/local/bin/node",
    probeNodeVersion: async (command) => (command === "/usr/local/bin/node" ? "v24.9.0" : undefined),
    ...overrides,
  };
}

describe("parseNodeMajor", () => {
  it("reads a v-prefixed version", () => {
    expect(parseNodeMajor("v24.9.0\n")).toBe(24);
  });

  it("reads a bare version", () => {
    expect(parseNodeMajor("22.1.0")).toBe(22);
  });

  it("returns undefined for garbage", () => {
    expect(parseNodeMajor("node: command not found")).toBeUndefined();
  });
});

describe("pathEntries", () => {
  it("splits, trims and drops empty entries", () => {
    expect(pathEntries(" /a::/b: ")).toEqual(["/a", "/b"]);
  });

  it("returns an empty list for an unset PATH", () => {
    expect(pathEntries(undefined)).toEqual([]);
  });
});

describe("gatewayEntryCandidates", () => {
  it("puts the env override first, then packaged, then the dev build, then PATH", () => {
    const candidates = gatewayEntryCandidates({
      env: { VOLTO_GATEWAY_BIN: "/opt/volto/bin.js", PATH: "/usr/local/bin" },
      isPackaged: true,
      appPath: "/repo/apps/desktop-app",
      resourcesPath: "/repo/Resources",
    });
    expect(candidates[0]).toEqual({ kind: "script", path: "/opt/volto/bin.js" });
    expect(candidates[1]).toEqual({ kind: "script", path: "/repo/Resources/gateway/bin.js" });
    expect(candidates[2]).toEqual({ kind: "script", path: "/repo/apps/gateway/dist/bin.js" });
    expect(candidates[3]).toEqual({ kind: "binary", path: "/usr/local/bin/volto" });
  });

  it("does not offer a Windows .cmd shim that a bare spawn cannot run", () => {
    const candidates = gatewayEntryCandidates({
      env: { PATH: "C:\\Program Files\\nodejs" },
      isPackaged: false,
      appPath: "C:\\repo\\apps\\desktop-app",
      resourcesPath: "C:\\repo\\Resources",
      platform: "win32",
    });
    expect(candidates.every((entry) => !entry.path.toLowerCase().endsWith(".cmd"))).toBe(true);
  });

  it("treats a non-script env override as a binary", () => {
    const candidates = gatewayEntryCandidates({
      env: { VOLTO_GATEWAY_BIN: "/opt/homebrew/bin/volto" },
      isPackaged: false,
      appPath: "/repo/apps/desktop-app",
      resourcesPath: "/repo/Resources",
    });
    expect(candidates[0]).toEqual({ kind: "binary", path: "/opt/homebrew/bin/volto" });
  });
});

describe("buildRuntime", () => {
  it("drops ELECTRON_RUN_AS_NODE for a system node runtime", () => {
    const runtime = buildRuntime({
      executable: "/usr/local/bin/node",
      electronAsNode: false,
      entry: { kind: "script", path: ENTRY },
      env: { ELECTRON_RUN_AS_NODE: "1", PATH: "/usr/bin" },
      label: "node 24.9.0",
    });
    expect(runtime).toEqual({
      command: "/usr/local/bin/node",
      argsPrefix: [ENTRY],
      env: { PATH: "/usr/bin" },
      label: "node 24.9.0",
      degraded: false,
    });
  });

  it("sets ELECTRON_RUN_AS_NODE for the Electron fallback and marks it degraded", () => {
    const runtime = buildRuntime({
      executable: "/repo/Electron",
      electronAsNode: true,
      entry: { kind: "script", path: ENTRY },
      env: { PATH: "/usr/bin" },
      label: "Electron 42.4.1",
    });
    expect(runtime.command).toBe("/repo/Electron");
    expect(runtime.env["ELECTRON_RUN_AS_NODE"]).toBe("1");
    expect(runtime.degraded).toBe(true);
  });

  it("runs a binary entry without a script argument", () => {
    const runtime = buildRuntime({
      executable: "/usr/local/bin/volto",
      electronAsNode: false,
      entry: { kind: "binary", path: "/usr/local/bin/volto" },
      env: {},
      label: "volto on PATH",
    });
    expect(runtime.argsPrefix).toEqual([]);
    expect(runtime.degraded).toBe(false);
  });
});

describe("resolveGatewayRuntime", () => {
  it("prefers a system node with a supported major", async () => {
    const runtime = await resolveGatewayRuntime(baseOptions());
    expect(runtime).toEqual({
      command: "/usr/local/bin/node",
      argsPrefix: [ENTRY],
      env: { PATH: "/usr/local/bin:/usr/bin" },
      label: "node 24.9.0",
      degraded: false,
    });
  });

  it("refuses a VOLTO_NODE below Node 22", async () => {
    await expect(
      resolveGatewayRuntime(
        baseOptions({
          env: { VOLTO_NODE: "/opt/node18/bin/node" },
          probeNodeVersion: async () => "v18.20.0",
        }),
      ),
    ).rejects.toThrow("VOLTO_NODE 需要 Node ≥ 22");
  });

  it("falls back to Electron's bundled node with a degraded marker", async () => {
    const runtime = await resolveGatewayRuntime(
      baseOptions({
        fileExists: async (filePath) => filePath === ENTRY || filePath === "/usr/local/bin/node",
        probeNodeVersion: async () => undefined,
        electronVersion: "42.4.1",
        electronNodeVersion: "24.16.0",
      }),
    );
    expect(runtime.command).toBe("/repo/node_modules/electron/dist/Electron");
    expect(runtime.env["ELECTRON_RUN_AS_NODE"]).toBe("1");
    expect(runtime.degraded).toBe(true);
    expect(runtime.label).toContain("Electron");
  });

  it("explains how to build the gateway when no entry exists", async () => {
    await expect(
      resolveGatewayRuntime(
        baseOptions({
          fileExists: async () => false,
          probeNodeVersion: async () => undefined,
        }),
      ),
    ).rejects.toThrow("VOLTO_GATEWAY_BIN");
  });

  it("reports a missing VOLTO_GATEWAY_BIN instead of guessing", async () => {
    await expect(
      resolveGatewayRuntime(
        baseOptions({
          env: { VOLTO_GATEWAY_BIN: "/nope/bin.js" },
          fileExists: async (filePath) => filePath === ENTRY || filePath === "/usr/local/bin/node",
        }),
      ),
    ).rejects.toThrow("/nope/bin.js");
  });
});
