/**
 * Owns the local gateway child process.
 *
 * The CLI's stdout is a contract (`apps/gateway/src/cli.ts`): exactly two
 * lines, the listening address and the authenticated URL. Readiness means
 * both have arrived; anything else (early exit, timeout) is a startup error
 * carrying the tail of stderr, because "it did not start" alone is not
 * actionable. The process is stopped with SIGTERM and SIGKILL as a backstop.
 */

import { spawn, type ChildProcess } from "node:child_process";

import type { GatewayProfile } from "@shared/gateway";
import type { GatewayRuntime } from "./runtime";

const DEFAULT_TIMEOUT_MS = 30_000;
const STOP_TIMEOUT_MS = 5_000;
const STDERR_TAIL_LINES = 40;
const ERROR_TAIL_LINES = 8;

/** Markers the gateway prints when better-sqlite3 could not be loaded. */
const DEGRADED_MARKERS = ["Sessions are now saved to", "sqlite session store"];

export interface RunningGateway {
  url: string;
  token: string;
  degraded: boolean;
  /** Diagnostic only (tests and logs); never relied on for control flow. */
  pid?: number;
  stop(): Promise<void>;
}

/** `volto gateway 0.2.1 listening on http://127.0.0.1:3100` -> the URL. */
export function parseGatewayListening(line: string): string | undefined {
  const match = /listening on (http:\/\/\S+)/.exec(line);
  return match?.[1];
}

/** `Open: http://…/?token=abc` -> `abc`; a line without a token -> `""`. */
export function parseGatewayOpenToken(line: string): string {
  const match = /^\s*Open:\s*(\S+)/.exec(line);
  if (match?.[1] === undefined) return "";
  try {
    return new URL(match[1]).searchParams.get("token") ?? "";
  } catch {
    return "";
  }
}

/**
 * Port the managed gateway should bind. An empty URL means "let the OS pick";
 * otherwise honor the port the user wrote, and never guess a privileged one.
 */
export function gatewayPortFor(profile: Pick<GatewayProfile, "url">): number {
  if (profile.url === "") return 0;
  try {
    const port = new URL(profile.url).port;
    return port === "" ? 0 : Number(port);
  } catch {
    return 0;
  }
}

/** Split a stream chunk into complete lines, keeping the remainder. */
function lineReader(onLine: (line: string) => void): (chunk: string) => void {
  let buffer = "";
  return (chunk: string) => {
    buffer += chunk;
    let index = buffer.indexOf("\n");
    while (index >= 0) {
      const line = buffer.slice(0, index).replace(/\r$/, "");
      buffer = buffer.slice(index + 1);
      onLine(line);
      index = buffer.indexOf("\n");
    }
  };
}

/**
 * Children that are still alive. A hard exit (app.exit, a crash) skips
 * before-quit, and a child process does not die with its parent, so the last
 * line of defence is a synchronous SIGKILL from the process exit hook.
 */
const liveChildren = new Set<ChildProcess>();
let exitHookInstalled = false;

function trackChild(child: ChildProcess): void {
  liveChildren.add(child);
  child.once("exit", () => {
    liveChildren.delete(child);
  });
  if (exitHookInstalled) return;
  exitHookInstalled = true;
  process.once("exit", () => {
    for (const tracked of liveChildren) {
      try {
        tracked.kill("SIGKILL");
      } catch {
        // Already gone.
      }
    }
  });
}

export interface LocalGatewaySupervisorOptions {
  timeoutMs?: number;
  /** Resolved by the caller so this module stays free of Electron and app paths. */
  runtime: () => Promise<GatewayRuntime>;
  spawn?: typeof spawn;
}

export class LocalGatewaySupervisor {
  private readonly timeoutMs: number;
  private readonly runtime: () => Promise<GatewayRuntime>;
  private readonly spawnFn: typeof spawn;
  private child?: ChildProcess;

  constructor(options: LocalGatewaySupervisorOptions) {
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.runtime = options.runtime;
    this.spawnFn = options.spawn ?? spawn;
  }

  async start(profile: GatewayProfile): Promise<RunningGateway> {
    await this.stop();
    const runtime = await this.runtime();
    const port = gatewayPortFor(profile);
    const args = [...runtime.argsPrefix, "--port", String(port), "--no-open"];
    const child = this.spawnFn(runtime.command, args, {
      env: runtime.env,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    this.child = child;
    trackChild(child);

    return await new Promise<RunningGateway>((resolve, reject) => {
      let url: string | undefined;
      let token = "";
      let sawOpen = false;
      let settled = false;
      let degraded = runtime.degraded;
      const stderrTail: string[] = [];

      const finish = (): void => {
        if (settled || url === undefined) return;
        settled = true;
        clearTimeout(timer);
        resolve({
          url,
          token,
          degraded,
          ...(child.pid !== undefined ? { pid: child.pid } : {}),
          stop: () => this.stopChild(child),
        });
      };

      const fail = (error: Error): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        void this.stopChild(child);
        reject(error);
      };

      const timer = setTimeout(() => {
        fail(new Error(`本地网关在 ${this.timeoutMs} ms 内没有启动`));
      }, this.timeoutMs);

      const stdout = lineReader((line) => {
        const listening = parseGatewayListening(line);
        if (listening !== undefined) url = listening;
        if (/^\s*Open:/.test(line)) {
          token = parseGatewayOpenToken(line);
          sawOpen = true;
        }
        if (url !== undefined && sawOpen) finish();
      });

      const stderr = lineReader((line) => {
        stderrTail.push(line);
        if (stderrTail.length > STDERR_TAIL_LINES) stderrTail.shift();
        if (DEGRADED_MARKERS.some((marker) => line.includes(marker))) degraded = true;
      });

      child.stdout?.setEncoding("utf8");
      child.stderr?.setEncoding("utf8");
      child.stdout?.on("data", stdout);
      child.stderr?.on("data", stderr);

      child.once("error", (error) => {
        fail(new Error(`无法启动本地网关：${error.message}`));
      });

      child.once("exit", (code, signal) => {
        if (this.child === child) this.child = undefined;
        const tail = stderrTail.slice(-ERROR_TAIL_LINES).join("\n");
        const reason = signal === null ? `退出码 ${String(code)}` : `信号 ${signal}`;
        fail(new Error(`本地网关启动失败（${reason}）${tail === "" ? "" : `：\n${tail}`}`));
      });
    });
  }

  async stop(): Promise<void> {
    const child = this.child;
    if (child !== undefined) await this.stopChild(child);
  }

  private async stopChild(child: ChildProcess): Promise<void> {
    if (this.child === child) this.child = undefined;
    if (child.exitCode !== null || child.signalCode !== null) return;
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        child.kill("SIGKILL");
        resolve();
      }, STOP_TIMEOUT_MS);
      child.once("exit", () => {
        clearTimeout(timer);
        resolve();
      });
      try {
        child.kill("SIGTERM");
      } catch {
        clearTimeout(timer);
        resolve();
      }
    });
  }
}