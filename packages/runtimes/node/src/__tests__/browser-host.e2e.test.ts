import { existsSync } from "node:fs";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createNodeBrowserHost, type BrowserHost } from "../browser-host.js";
import { startBrowserFixture, type BrowserFixture } from "./fixtures/browser-app.js";

const describeE2E = process.env["VOLTO_BROWSER_E2E"] === "1" ? describe : describe.skip;

function refFor(snapshot: string, role: string, name: string): string {
  const pattern = new RegExp(`- ${role} "${name}" \\[ref=(e\\d+)\\]`);
  const match = pattern.exec(snapshot);
  if (match?.[1] === undefined) throw new Error(`no ${role} "${name}" in snapshot:\n${snapshot}`);
  return match[1];
}

describeE2E("browser host (real Chromium)", () => {
  let fixture: BrowserFixture;
  let host: BrowserHost;
  let dir: string;
  let authPath: string;

  beforeAll(async () => {
    fixture = await startBrowserFixture();
    dir = await mkdtemp(join(tmpdir(), "volto-browser-"));
    authPath = join(dir, "auth.json");
    const executablePath = process.env["VOLTO_BROWSER_EXECUTABLE"] ??
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
    host = createNodeBrowserHost({
      headless: false,
      storageStatePath: authPath,
      ...(existsSync(executablePath) ? { executablePath } : {}),
    });
  });

  afterAll(async () => {
    await host?.dispose();
    await fixture?.close();
    await rm(dir, { recursive: true, force: true });
  });

  it("fills a form, reports the failing request, and screenshots", async () => {
    const page = host.page("session-a");
    const login = await page.navigate(`${fixture.url}/login`);
    expect(login.state.title).toBe("Sign in");

    const snapshot = await page.snapshot();
    const email = refFor(snapshot.text, "textbox", "Email");
    const password = refFor(snapshot.text, "textbox", "Password");
    const submit = refFor(snapshot.text, "button", "Sign in");

    await page.type(email, "a@b.c");
    await page.type(password, "secret");
    await page.click(submit);
    const after = await page.waitFor({ text: "Invalid credentials", timeoutMs: 5000 });
    expect(after.state.url).toContain("/login");

    const network = await page.diagnostics({ kind: "network" });
    expect(network.text).toContain("500 POST");
    expect(network.text).toContain("/api/login");

    const shot = await page.screenshot();
    expect(shot.data.length).toBeGreaterThan(100);
    expect(shot.width).toBe(1280);
  });

  it("saves a storage state with restrictive permissions", async () => {
    const page = host.page("session-a");
    const saved = await page.storageState("save");
    expect(saved.path).toBe(authPath);
    const info = await stat(authPath);
    expect(info.mode & 0o777).toBe(0o600);
  });


  it("reuses a saved storage state in a fresh context", async () => {
    const executablePath = process.env["VOLTO_BROWSER_EXECUTABLE"] ??
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
    const options = {
      headless: false,
      storageStatePath: authPath,
      ...(existsSync(executablePath) ? { executablePath } : {}),
    };
    const first = createNodeBrowserHost(options);
    const page = first.page("auth-login");
    await page.navigate(`${fixture.url}/login-ok`);
    const snapshot = await page.snapshot();
    await page.type(refFor(snapshot.text, "textbox", "Email"), "a@b.c");
    await page.type(refFor(snapshot.text, "textbox", "Password"), "secret");
    await page.click(refFor(snapshot.text, "button", "Sign in"));
        await page.waitFor({ text: "Dashboard", timeoutMs: 5000 });
    await page.storageState("save");
    await first.dispose();

    const second = createNodeBrowserHost(options);
    try {
      const state = await second.page("auth-reuse").navigate(`${fixture.url}/dashboard`);
      expect(state.state.title).toBe("Dashboard");
    } finally {
      await second.dispose();
    }
  });

  it("records console errors", async () => {
    const page = host.page("session-console");
    await page.navigate(`${fixture.url}/console`);
    const console = await page.diagnostics({ kind: "console", level: "error" });
    expect(console.text).toContain("fixture boom");
  });

  it("blocks a click-driven navigation to a denied host", async () => {
    const page = host.page("session-denied");
    await page.navigate(`${fixture.url}/denied`);
    const snapshot = await page.snapshot();
    const link = refFor(snapshot.text, "link", "metadata");
    await page.click(link);
    await new Promise((resolve) => setTimeout(resolve, 300));
    const state = await page.state();
    expect(state.url).not.toContain("169.254");
  });
});
