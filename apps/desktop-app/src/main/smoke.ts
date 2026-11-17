/**
 * Dev-only end-to-end check: wait for the active gateway to come online,
 * capture both views, write a small report, quit. Enabled by
 * `VOLTO_DESKTOP_SMOKE=<output dir>`; never runs otherwise.
 *
 * Capture goes through the DevTools protocol rather than
 * `webContents.capturePage()`: a `WebContentsView` has no standalone display
 * surface, so `capturePage` fails with "Current display surface not available
 * for capture" even with the window visible. `Page.captureScreenshot` renders
 * the view's own compositor and works in that situation.
 */

import { app, type WebContents } from "electron";
import { mkdir, writeFile } from "node:fs/promises";
import * as path from "node:path";

import type { ProfileDraft } from "@shared/gateway";

import type { GatewayController } from "./gateway/controller";
import type { ShellWindow } from "./shell/window";

const ONLINE_TIMEOUT_MS = 60_000;
const PAINT_SETTLE_MS = 2_000;

async function wait(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForTerminal(controller: GatewayController, timeoutMs: number): Promise<void> {
  const started = Date.now();
  for (;;) {
    const state = controller.getState().status.state;
    if (state === "online" || state === "offline") return;
    if (Date.now() - started > timeoutMs) throw new Error("smoke: switch did not settle");
    await wait(250);
  }
}

async function capture(contents: WebContents, file: string): Promise<void> {
  if (contents.isDestroyed()) throw new Error(`smoke: ${file} view is gone`);
  if (contents.debugger.isAttached()) contents.debugger.detach();
  contents.debugger.attach("1.3");
  try {
    const result = (await contents.debugger.sendCommand("Page.captureScreenshot", {
      format: "png",
    })) as { data?: string };
    if (typeof result.data !== "string") throw new Error("smoke: empty screenshot");
    await writeFile(file, Buffer.from(result.data, "base64"));
  } finally {
    if (contents.debugger.isAttached()) contents.debugger.detach();
  }
}

export async function runSmoke(options: {
  shell: ShellWindow;
  controller: GatewayController;
  outputDir: string;
}): Promise<void> {
  const started = Date.now();
  while (options.controller.getState().status.state !== "online") {
    if (Date.now() - started > ONLINE_TIMEOUT_MS) {
      throw new Error("smoke: the gateway did not come online in time");
    }
    await wait(250);
  }
  await wait(PAINT_SETTLE_MS);

  await mkdir(options.outputDir, { recursive: true });
  const state = options.controller.getState();
  const report = {
    status: state.status,
    activeProfileId: state.activeProfileId,
    shellUrl: options.shell.shellView.webContents.getURL(),
    contentUrl: options.shell.contentView.webContents.getURL(),
    contentTitle: options.shell.contentView.webContents.getTitle(),
    shellBounds: options.shell.shellView.getBounds(),
    contentBounds: options.shell.contentView.getBounds(),
    appVersion: state.appVersion,
    capturedAt: new Date().toISOString(),
  };
  await writeFile(
    path.join(options.outputDir, "smoke.json"),
    `${JSON.stringify(report, null, 2)}\n`,
    "utf8",
  );

  await capture(
    options.shell.shellView.webContents,
    path.join(options.outputDir, "shell.png"),
  );
  await capture(
    options.shell.contentView.webContents,
    path.join(options.outputDir, "content.png"),
  );

  const profileJson = process.env["VOLTO_DESKTOP_SMOKE_PROFILE"];
  if (profileJson !== undefined && profileJson !== "") {
    const draft = JSON.parse(profileJson) as ProfileDraft;
    const saved = await options.controller.saveProfile(draft);
    if (!saved.ok) throw new Error(`smoke: cannot save the extra profile: ${saved.error}`);
    const profile = saved.state.profiles.find(
      (entry) => entry.label === draft.label && entry.kind === draft.kind,
    );
    if (profile === undefined) throw new Error("smoke: saved profile is missing");
    await options.controller.switchProfile(profile.id);
    await waitForTerminal(options.controller, 60_000);
    await wait(1_500);
    const switched = options.controller.getState();
    await writeFile(
      path.join(options.outputDir, "switch.json"),
      `${JSON.stringify(
        {
          wanted: draft,
          activeProfileId: switched.activeProfileId,
          status: switched.status,
          contentUrl: options.shell.contentView.webContents.getURL(),
          contentTitle: options.shell.contentView.webContents.getTitle(),
        },
        null,
        2,
      )}\n`,
      "utf8",
    );
    await capture(
      options.shell.contentView.webContents,
      path.join(options.outputDir, "switched.png"),
    );
    options.controller.setSheetOpen(true);
    await wait(600);
    await capture(
      options.shell.shellView.webContents,
      path.join(options.outputDir, "switched-sheet.png"),
    );
  }

  if (process.env["VOLTO_DESKTOP_SMOKE_SHEET"] === "1") {
    options.controller.setSheetOpen(true);
    await wait(600);
    await capture(
      options.shell.shellView.webContents,
      path.join(options.outputDir, "sheet.png"),
    );
  }

  if (process.env["VOLTO_DESKTOP_SMOKE_FORM"] === "1") {
    await options.shell.shellView.webContents.executeJavaScript(`
      [...document.querySelectorAll("button")].find((button) =>
        (button.textContent ?? "").includes("添加网关"),
      )?.click();
    `);
    await wait(600);
    await capture(
      options.shell.shellView.webContents,
      path.join(options.outputDir, "form.png"),
    );
  }

  app.quit();
}