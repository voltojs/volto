/**
 * Resolve a Chromium executable owned by the user.
 *
 * volto never installs a browser into the repository: Playwright is only a
 * driver. The host prefers `browser.executablePath`, then probes the common
 * Chrome/Chromium/Edge locations for the current platform.
 */

import { constants } from "node:fs";
import { access, stat } from "node:fs/promises";
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

export type SystemBrowserId = "chrome" | "chromium" | "edge" | "brave";

export interface SystemBrowser {
  id: SystemBrowserId;
  label: string;
  path: string;
}

function macBrowsers(home: string): SystemBrowser[] {
  return [
    {
      id: "chrome",
      label: "Google Chrome",
      path: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    },
    {
      id: "chrome",
      label: "Google Chrome",
      path: path.join(home, "Applications/Google Chrome.app/Contents/MacOS/Google Chrome"),
    },
    {
      id: "chromium",
      label: "Chromium",
      path: "/Applications/Chromium.app/Contents/MacOS/Chromium",
    },
    {
      id: "edge",
      label: "Microsoft Edge",
      path: "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
    },
    {
      id: "brave",
      label: "Brave Browser",
      path: "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser",
    },
  ];
}

function windowsBrowsers(env: NodeJS.ProcessEnv): SystemBrowser[] {
  const roots = [env["ProgramFiles"], env["ProgramFiles(x86)"], env["LOCALAPPDATA"]].filter(
    (root): root is string => root !== undefined && root !== "",
  );
  const relative: Array<{ id: SystemBrowserId; label: string; parts: string[] }> = [
    { id: "chrome", label: "Google Chrome", parts: ["Google", "Chrome", "Application", "chrome.exe"] },
    { id: "edge", label: "Microsoft Edge", parts: ["Microsoft", "Edge", "Application", "msedge.exe"] },
    { id: "chromium", label: "Chromium", parts: ["Chromium", "Application", "chrome.exe"] },
  ];
  return roots.flatMap((root) =>
    relative.map((browser) => ({
      id: browser.id,
      label: browser.label,
      path: path.win32.join(root, ...browser.parts),
    })),
  );
}

function linuxBrowsers(): SystemBrowser[] {
  return [
    { id: "chrome", label: "Google Chrome", path: "/usr/bin/google-chrome" },
    { id: "chrome", label: "Google Chrome", path: "/usr/bin/google-chrome-stable" },
    { id: "chrome", label: "Google Chrome", path: "/usr/local/bin/google-chrome" },
    { id: "chrome", label: "Google Chrome", path: "/opt/google/chrome/chrome" },
    { id: "chromium", label: "Chromium", path: "/usr/bin/chromium" },
    { id: "chromium", label: "Chromium", path: "/usr/bin/chromium-browser" },
    { id: "chromium", label: "Chromium", path: "/usr/local/bin/chromium" },
    { id: "chromium", label: "Chromium", path: "/snap/bin/chromium" },
    { id: "edge", label: "Microsoft Edge", path: "/usr/bin/microsoft-edge" },
    { id: "edge", label: "Microsoft Edge", path: "/usr/bin/microsoft-edge-stable" },
    { id: "brave", label: "Brave Browser", path: "/usr/bin/brave-browser" },
  ];
}

/** Common system-browser locations with display labels, in probe order. */
export function systemBrowsers(
  platform: NodeJS.Platform,
  env: NodeJS.ProcessEnv,
  home: string = os.homedir(),
): SystemBrowser[] {
  if (platform === "darwin") return macBrowsers(home);
  if (platform === "win32") return windowsBrowsers(env);
  return linuxBrowsers();
}

export function systemBrowserCandidates(
  platform: NodeJS.Platform,
  env: NodeJS.ProcessEnv,
  home: string = os.homedir(),
): string[] {
  return systemBrowsers(platform, env, home).map((browser) => browser.path);
}

async function isExecutable(candidate: string, platform: NodeJS.Platform): Promise<boolean> {
  try {
    const info = await stat(candidate);
    if (!info.isFile()) return false;
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
  for (const browser of systemBrowsers(platform, env, home)) {
    if (await exists(browser.path)) return browser.path;
  }
  return undefined;
}

/** Installed, executable browsers for the gateway's platform. */
export async function detectSystemBrowsers(
  opts: ResolveBrowserExecutableOptions = {},
): Promise<SystemBrowser[]> {
  const platform = opts.platform ?? process.platform;
  const env = opts.env ?? process.env;
  const home = opts.home ?? os.homedir();
  const exists = opts.exists ?? ((candidate: string) => isExecutable(candidate, platform));
  const detected: SystemBrowser[] = [];
  const seen = new Set<string>();
  for (const browser of systemBrowsers(platform, env, home)) {
    if (seen.has(browser.path)) continue;
    if (await exists(browser.path)) {
      seen.add(browser.path);
      detected.push(browser);
    }
  }
  return detected;
}
