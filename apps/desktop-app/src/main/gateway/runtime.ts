/**
 * Resolve how to start a local gateway: which Node runtime to use, and where
 * the gateway entry point lives.
 *
 * The order is deliberate. A system Node (>= 22) keeps better-sqlite3 on the
 * ABI it was built for; Electron's bundled Node does not, so the gateway falls
 * back to its file session store. That fallback is still usable, but the user
 * has to see it — hence `degraded` travels with the runtime.
 */

import { execFile } from "node:child_process";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const MIN_NODE_MAJOR = 22;

export interface GatewayRuntime {
  command: string;
  /** Arguments before the gateway's own flags (the script path, or nothing). */
  argsPrefix: string[];
  env: NodeJS.ProcessEnv;
  /** Shown in status/diagnostics. */
  label: string;
  /** True when the runtime cannot load native sqlite (Electron fallback). */
  degraded: boolean;
}

export interface GatewayEntry {
  kind: "script" | "binary";
  path: string;
}

export interface RuntimeResolveOptions {
  env?: NodeJS.ProcessEnv;
  isPackaged: boolean;
  appPath: string;
  resourcesPath: string;
  execPath: string;
  pathEnv?: string;
  fileExists?: (filePath: string) => Promise<boolean>;
  /** Resolve a node binary's `--version` output; `undefined` when it cannot run. */
  probeNodeVersion?: (command: string) => Promise<string | undefined>;
  /** Electron version, defaulting to the running app's. */
  electronVersion?: string;
  /** Node version inside Electron, defaulting to the running app's. */
  electronNodeVersion?: string;
}

/** `v24.9.0` / `24.9.0` -> 24; anything unparseable -> undefined. */
export function parseNodeMajor(output: string): number | undefined {
  const match = /^v?(\d+)(?:\.|$)/.exec(output.trim());
  return match?.[1] !== undefined ? Number(match[1]) : undefined;
}

/** Non-empty PATH entries, order preserved. */
export function pathEntries(pathEnv: string | undefined): string[] {
  if (pathEnv === undefined) return [];
  return pathEnv
    .split(path.delimiter)
    .map((entry) => entry.trim())
    .filter((entry) => entry !== "");
}

/** Every place a gateway entry point could be, in priority order. */
export function gatewayEntryCandidates(o: {
  env: NodeJS.ProcessEnv;
  isPackaged: boolean;
  appPath: string;
  resourcesPath: string;
}): GatewayEntry[] {
  const candidates: GatewayEntry[] = [];
  const push = (entry: GatewayEntry): void => {
    if (!candidates.some((existing) => existing.path === entry.path)) candidates.push(entry);
  };

  const override = o.env["VOLTO_GATEWAY_BIN"]?.trim();
  if (override !== undefined && override !== "") {
    push({ kind: isScriptPath(override) ? "script" : "binary", path: override });
  }
  if (o.isPackaged) {
    push({ kind: "script", path: path.join(o.resourcesPath, "gateway", "bin.js") });
  }
  push({ kind: "script", path: path.resolve(o.appPath, "..", "gateway", "dist", "bin.js") });

  const names = process.platform === "win32" ? ["volto.cmd", "volto.exe", "volto"] : ["volto"];
  for (const dir of pathEntries(o.env["PATH"])) {
    for (const name of names) push({ kind: "binary", path: path.join(dir, name) });
  }
  return candidates;
}

function isScriptPath(filePath: string): boolean {
  return /\.(?:mjs|cjs|js)$/i.test(filePath);
}

/** Build the concrete spawn plan, normalizing the child environment. */
export function buildRuntime(o: {
  executable: string;
  electronAsNode: boolean;
  entry: GatewayEntry;
  env: NodeJS.ProcessEnv;
  label: string;
}): GatewayRuntime {
  const env: NodeJS.ProcessEnv = { ...o.env };
  // ELECTRON_RUN_AS_NODE is meaningless (and confusing) for a system node;
  // for Electron's binary it is the whole mechanism.
  delete env["ELECTRON_RUN_AS_NODE"];
  if (o.electronAsNode) env["ELECTRON_RUN_AS_NODE"] = "1";
  return {
    command: o.executable,
    argsPrefix: o.entry.kind === "script" ? [o.entry.path] : [],
    env,
    label: o.label,
    degraded: o.electronAsNode,
  };
}

async function defaultFileExists(filePath: string): Promise<boolean> {
  try {
    return (await fs.stat(filePath)).isFile();
  } catch {
    return false;
  }
}

async function defaultProbeNodeVersion(command: string): Promise<string | undefined> {
  try {
    const { stdout } = await execFileAsync(command, ["--version"], { timeout: 3000 });
    return stdout.trim();
  } catch {
    return undefined;
  }
}

async function firstExisting(
  candidates: readonly GatewayEntry[],
  fileExists: (filePath: string) => Promise<boolean>,
): Promise<GatewayEntry | undefined> {
  for (const candidate of candidates) {
    if (await fileExists(candidate.path)) return candidate;
  }
  return undefined;
}

/**
 * Resolve the runtime for a managed local gateway. Throws an actionable error
 * when neither a usable Node nor a gateway entry point can be found.
 */
export async function resolveGatewayRuntime(o: RuntimeResolveOptions): Promise<GatewayRuntime> {
  const env: NodeJS.ProcessEnv = { ...(o.env ?? process.env) };
  // `pathEnv` exists so tests can pin the lookup without replacing the whole
  // environment; it is the same PATH every candidate consults.
  if (o.pathEnv !== undefined) env["PATH"] = o.pathEnv;
  const fileExists = o.fileExists ?? defaultFileExists;
  const probeNodeVersion = o.probeNodeVersion ?? defaultProbeNodeVersion;
  const candidates = gatewayEntryCandidates({
    env,
    isPackaged: o.isPackaged,
    appPath: o.appPath,
    resourcesPath: o.resourcesPath,
  });

  const override = env["VOLTO_GATEWAY_BIN"]?.trim();
  let entry: GatewayEntry | undefined;
  if (override !== undefined && override !== "") {
    entry = candidates[0];
    if (entry === undefined || !(await fileExists(entry.path))) {
      throw new Error(`VOLTO_GATEWAY_BIN 指向的文件不存在：${override}`);
    }
  } else {
    entry = await firstExisting(candidates, fileExists);
    if (entry === undefined) {
      const expected = path.resolve(o.appPath, "..", "gateway", "dist", "bin.js");
      throw new Error(
        `找不到本地网关：${expected} 不存在。先运行 pnpm turbo run build --filter @voltojs/gateway，或设置 VOLTO_GATEWAY_BIN。`,
      );
    }
  }

  if (entry.kind === "binary") {
    const childEnv: NodeJS.ProcessEnv = { ...env };
    delete childEnv["ELECTRON_RUN_AS_NODE"];
    return {
      command: entry.path,
      argsPrefix: [],
      env: childEnv,
      label: `volto (${entry.path})`,
      degraded: false,
    };
  }

  const nodeOverride = env["VOLTO_NODE"]?.trim();
  if (nodeOverride !== undefined && nodeOverride !== "") {
    const version = await probeNodeVersion(nodeOverride);
    const major = version === undefined ? undefined : parseNodeMajor(version);
    if (version === undefined || major === undefined) {
      throw new Error(`VOLTO_NODE 无法执行：${nodeOverride}`);
    }
    if (major < MIN_NODE_MAJOR) {
      throw new Error(`VOLTO_NODE 需要 Node ≥ ${MIN_NODE_MAJOR}，当前 ${version}`);
    }
    return buildRuntime({ executable: nodeOverride, electronAsNode: false, entry, env, label: `node ${version.replace(/^v/, "")}` });
  }

  let olderNode: string | undefined;
  for (const dir of pathEntries(env["PATH"])) {
    const command = path.join(dir, process.platform === "win32" ? "node.exe" : "node");
    if (!(await fileExists(command))) continue;
    const version = await probeNodeVersion(command);
    if (version === undefined) continue;
    const major = parseNodeMajor(version);
    if (major === undefined) continue;
    if (major >= MIN_NODE_MAJOR) {
      return buildRuntime({ executable: command, electronAsNode: false, entry, env, label: `node ${version.replace(/^v/, "")}` });
    }
    olderNode ??= version;
  }

  const electronVersion = o.electronVersion ?? process.versions.electron;
  const electronNodeVersion = o.electronNodeVersion ?? process.versions.node;
  if (electronVersion === undefined) {
    const detail = olderNode === undefined ? "未找到 Node" : `PATH 上的 Node ${olderNode} 低于 ${MIN_NODE_MAJOR}`;
    throw new Error(`${detail}：请安装 Node ≥ ${MIN_NODE_MAJOR}，或设置 VOLTO_NODE。`);
  }
  return buildRuntime({
    executable: o.execPath,
    electronAsNode: true,
    entry,
    env,
    label: `Electron ${electronVersion} 内置 Node ${electronNodeVersion}`,
  });
}