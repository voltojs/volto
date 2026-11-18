import { afterEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { WebSearchCard } from "../WebSearchCard";
import type { WebSearchSettingsView } from "@/lib/config-api";

Element.prototype.hasPointerCapture ??= () => false;
Element.prototype.setPointerCapture ??= () => {};
Element.prototype.releasePointerCapture ??= () => {};
Element.prototype.scrollIntoView ??= () => {};

const BASE: WebSearchSettingsView = {
  source: "auto",
  builtins: {
    deepseek: { apiKeyMasked: null, sourceProviderId: null, baseUrl: null },
    brave: { apiKeyMasked: null, baseUrl: null },
    glm: { apiKeyMasked: null, baseUrl: null },
  },
  custom: [],
  candidates: [{ id: "deepseek", name: "DeepSeek", apiKeyMasked: "sk-…7890" }],
  resolved: { sourceId: "deepseek", label: "DeepSeek", reason: "auto-channel" },
  warnings: [],
};

function stubApi(overrides: Partial<WebSearchSettingsView> = {}) {
  const calls: Array<{ method: string; body: unknown }> = [];
  const view = { ...BASE, ...overrides };
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/config/web-search/test")) {
        calls.push({ method: "POST", body: JSON.parse(String(init?.body ?? "{}")) });
        return new Response(
          JSON.stringify({
            resolved: { sourceId: "glm", label: "GLM", reason: "configured" },
            hits: [
              { title: "Alpha", url: "https://a.example" },
              { title: "Beta", url: "https://b.example" },
              { title: "Gamma", url: "https://c.example" },
              { title: "Delta", url: "https://d.example" },
            ],
          }),
          { status: 200 },
        );
      }
      if (url.endsWith("/config/web-search") && init?.method === "PUT") {
        const body = JSON.parse(String(init.body)) as Record<string, unknown>;
        calls.push({ method: "PUT", body });
        return new Response(JSON.stringify({ ...view, source: String(body["source"]) }), {
          status: 200,
        });
      }
      if (url.endsWith("/config/web-search")) return new Response(JSON.stringify(view), { status: 200 });
      return new Response(JSON.stringify({}), { status: 404 });
    }),
  );
  return calls;
}

afterEach(() => vi.unstubAllGlobals());

describe("WebSearchCard", () => {
  it("shows the resolved source and saves a DeepSeek key", async () => {
    const calls = stubApi();
    const user = userEvent.setup();
    render(<WebSearchCard />);
    expect(await screen.findByText(/自动 → 复用 DeepSeek 渠道/)).toBeInTheDocument();

    await user.click(screen.getByRole("combobox", { name: "搜索源" }));
    await user.click(await screen.findByRole("option", { name: "DeepSeek" }));
    await user.type(screen.getByLabelText("API Key"), "sk-new");
    await user.click(screen.getByRole("button", { name: "保存" }));

    await waitFor(() =>
      expect(calls).toEqual([
        { method: "PUT", body: { source: "deepseek", deepseek: { apiKey: "sk-new", sourceProviderId: null } } },
      ]),
    );
  });

  it("reuses a channel instead of a key", async () => {
    const calls = stubApi();
    const user = userEvent.setup();
    render(<WebSearchCard />);
    await screen.findByText(/自动 → 复用 DeepSeek 渠道/);
    await user.click(screen.getByRole("combobox", { name: "搜索源" }));
    await user.click(await screen.findByRole("option", { name: "DeepSeek" }));
    await user.click(screen.getByRole("combobox", { name: "鉴权方式" }));
    await user.click(await screen.findByRole("option", { name: "复用模型渠道" }));
    await user.click(screen.getByRole("combobox", { name: "模型渠道" }));
    await user.click(await screen.findByRole("option", { name: "DeepSeek" }));
    await user.click(screen.getByRole("button", { name: "保存" }));

    await waitFor(() =>
      expect(calls[0]?.body).toEqual({
        source: "deepseek",
        deepseek: { sourceProviderId: "deepseek" },
      }),
    );
  });

  it("explains an empty channel list", async () => {
    stubApi({ candidates: [] });
    const user = userEvent.setup();
    render(<WebSearchCard />);
    await screen.findByText(/自动 → 复用 DeepSeek 渠道/);
    await user.click(screen.getByRole("combobox", { name: "搜索源" }));
    await user.click(await screen.findByRole("option", { name: "DeepSeek" }));
    await user.click(screen.getByRole("combobox", { name: "鉴权方式" }));
    await user.click(await screen.findByRole("option", { name: "复用模型渠道" }));
    expect(await screen.findByText(/先去「模型配置」添加一个/)).toBeInTheDocument();
  });

  it("shows the first three hits from a test search", async () => {
    stubApi();
    const user = userEvent.setup();
    render(<WebSearchCard />);
    await screen.findByText(/自动 → 复用 DeepSeek 渠道/);
    await user.click(screen.getByRole("button", { name: "测试搜索" }));
    expect(await screen.findByText("Alpha")).toBeInTheDocument();
    expect(screen.getByText("Gamma")).toBeInTheDocument();
    expect(screen.queryByText("Delta")).not.toBeInTheDocument();
  });
});
