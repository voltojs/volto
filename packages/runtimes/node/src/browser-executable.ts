/**
 * Resolve a Chromium executable owned by the user.
 *
 * volto never installs a browser into the repository: Playwright is only a
 * driver. The host prefers `browser.executablePath`, then probes the common
 * Chrome/Chromium/Edge locations for the current platform.
 */

import { constants } from "node:fs";
import { access } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

export interface ResolveBrowserExecutableOptions {
  /** `browser.executablePath` from config; expanded for a leading `~`. */
  configured?: string;
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  home?: string;
  /** Test seam: replace the filesystem check. */
  exists?: (candidate: string) => Promise<boolean>;
}

/** Expand a leading `~` or `~/` to `home`; other paths pass through. */
export function expandHome(value: string, home: string): string {
  if (value === "~") return home;
  if (value.startsWith("~/")) return path.join(home, value.slice(2));
  return value;
}

function macCandidates(home: string): string[] {
  return [
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    path.join(home, "Applications/Google Chrome.app/Contents/MacOS/Google Chrome"),
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
    "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
    "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser",
  ];
}

function windowsCandidates(env: NodeJS.ProcessEnv): string[] {
  const roots = [env["ProgramFiles"], env["ProgramFiles(x86)"], env["LOCALAPPDATA"]].filter(
    (root): root is string => root !== undefined && root !== "",
  );
  const relative = [
    ["Google", "Chrome", "Application", "chrome.exe"],
    ["Microsoft", "Edge", "Application", "msedge.exe"],
    ["Chromium", "Application", "chrome.exe"],
  ];
  return roots.flatMap((root) => relative.map((parts) => path.win32.join(root, ...parts)));
}

function linuxCandidates(): string[] {
  return [
    "/usr/bin/google-chrome",
    "/usr/bin/google-chrome-stable",
    "/usr/local/bin/google-chrome",
    "/opt/google/chrome/chrome",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
    "/usr/local/bin/chromium",
    "/snap/bin/chromium",
    "/usr/bin/microsoft-edge",
    "/usr/bin/microsoft-edge-stable",
    "/usr/bin/brave-browser",
  ];
}

/** Common system-browser locations in probe order. */
export function systemBrowserCandidates(
  platform: NodeJS.Platform,
  env: NodeJS.ProcessEnv,
  home: string = os.homedir(),
): string[] {
  if (platform === "darwin") return macCandidates(home);
  if (platform === "win32") return windowsCandidates(env);
  return linuxCandidates();
}

async function isExecutable(candidate: string, platform: NodeJS.Platform): Promise<boolean> {
  try {
    await access(candidate, platform === "win32" ? constants.F_OK : constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Resolve the browser to launch. A configured path wins even when missing
 * (the caller reports that as a configuration error instead of silently
 * launching a different browser); otherwise the first common install wins.
 */
export async function resolveBrowserExecutable(
  opts: ResolveBrowserExecutableOptions = {},
): Promise<string | undefined> {
  const platform = opts.platform ?? process.platform;
  const env = opts.env ?? process.env;
  const home = opts.home ?? os.homedir();
  const exists = opts.exists ?? ((candidate: string) => isExecutable(candidate, platform));
  if (opts.configured !== undefined) {
    const configured = expandHome(opts.configured, home);
    return (await exists(configured)) ? configured : undefined;
  }
  for (const candidate of systemBrowserCandidates(platform, env, home)) {
    if (await exists(candidate)) return candidate;
  }
  return undefined;
}
