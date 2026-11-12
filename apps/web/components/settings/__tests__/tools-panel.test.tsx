import { afterEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ToolsPanel } from "../ToolsPanel";
import type { BrowserSettingsView } from "@/lib/config-api";

// Base UI Select needs these in jsdom.
Element.prototype.hasPointerCapture ??= () => false;
Element.prototype.setPointerCapture ??= () => {};
Element.prototype.releasePointerCapture ??= () => {};
Element.prototype.scrollIntoView ??= () => {};

const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

const VIEW: BrowserSettingsView = {
  platform: "darwin",
  configuredPath: null,
  resolvedPath: CHROME,
  browsers: [{ id: "chrome", label: "Google Chrome", path: CHROME }],
};

function stubBrowserApi(view: BrowserSettingsView = VIEW) {
  const calls: Array<{ method: string; body: unknown }> = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (!url.endsWith("/config/browser")) {
        return new Response(JSON.stringify({}), { status: 404 });
      }
      if (init?.method === "PUT") {
        const body = JSON.parse(String(init.body)) as { executablePath: string | null };
        calls.push({ method: "PUT", body });
        return new Response(
          JSON.stringify({
            ...VIEW,
            configuredPath: body.executablePath,
            resolvedPath: body.executablePath,
          }),
          { status: 200 },
        );
      }
      return new Response(JSON.stringify(view), { status: 200 });
    }),
  );
  return calls;
}

afterEach(() => vi.unstubAllGlobals());

async function chooseBrowser(label: string): Promise<void> {
  const user = userEvent.setup();
  await user.click(screen.getByRole("combobox"));
  await user.click(await screen.findByRole("option", { name: label }));
}

describe("ToolsPanel browser settings", () => {
  it("shows the gateway platform and detected browsers", async () => {
    stubBrowserApi();
    render(<ToolsPanel />);
    expect(await screen.findByText("网关系统：macOS")).toBeInTheDocument();
    expect(screen.getByText(/重启网关后生效/)).toBeInTheDocument();
    await chooseBrowser("Google Chrome");
    expect(screen.getByRole("combobox")).toHaveTextContent("Google Chrome");
  });

  it("saves a detected browser path", async () => {
    const calls = stubBrowserApi();
    const user = userEvent.setup();
    render(<ToolsPanel />);
    await screen.findByText("网关系统：macOS");
    await chooseBrowser("Google Chrome");
    await user.click(screen.getByRole("button", { name: "保存" }));
    await waitFor(() => expect(calls).toEqual([{ method: "PUT", body: { executablePath: CHROME } }]));
    expect(await screen.findByText(/已写入 config.json/)).toBeInTheDocument();
  });

  it("saves a custom path and disables save while it is empty", async () => {
    const calls = stubBrowserApi();
    const user = userEvent.setup();
    render(<ToolsPanel />);
    await screen.findByText("网关系统：macOS");
    await chooseBrowser("自定义路径");
    const save = screen.getByRole("button", { name: "保存" });
    expect(save).toBeDisabled();
    await user.type(screen.getByLabelText("浏览器可执行文件路径"), "/opt/chrome");
    await user.click(save);
    await waitFor(() =>
      expect(calls).toEqual([{ method: "PUT", body: { executablePath: "/opt/chrome" } }]),
    );
  });

  it("saves null when auto-detect is selected", async () => {
    const calls = stubBrowserApi({ ...VIEW, configuredPath: CHROME });
    const user = userEvent.setup();
    render(<ToolsPanel />);
    await screen.findByText("网关系统：macOS");
    await chooseBrowser("自动探测");
    await user.click(screen.getByRole("button", { name: "保存" }));
    await waitFor(() => expect(calls[0]?.body).toEqual({ executablePath: null }));
  });
});
