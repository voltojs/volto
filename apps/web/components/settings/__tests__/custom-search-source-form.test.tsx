import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { CustomSearchSourceForm } from "../CustomSearchSourceForm";
import { CustomSearchSources } from "../CustomSearchSources";
import type { WebSearchSettingsView } from "@/lib/config-api";

Element.prototype.hasPointerCapture ??= () => false;
Element.prototype.setPointerCapture ??= () => {};
Element.prototype.releasePointerCapture ??= () => {};
Element.prototype.scrollIntoView ??= () => {};

const VIEW: WebSearchSettingsView = {
  source: "auto",
  builtins: {
    deepseek: { apiKeyMasked: null, sourceProviderId: null, baseUrl: null },
    brave: { apiKeyMasked: null, baseUrl: null },
    glm: { apiKeyMasked: null, baseUrl: null },
  },
  custom: [
    { id: "mine", name: "我的搜索", method: "POST", url: "https://s.example.com/search", apiKeyMasked: "…1234" },
  ],
  candidates: [],
  resolved: { sourceId: "none", label: "Not configured", reason: "unconfigured" },
  warnings: [],
};

afterEach(() => vi.unstubAllGlobals());

describe("CustomSearchSourceForm", () => {
  it("submits the template and the mapping paths", async () => {
    const onSubmit = vi.fn(() => Promise.resolve());
    const user = userEvent.setup();
    render(<CustomSearchSourceForm onSubmit={onSubmit} onCancel={vi.fn()} />);

    await user.type(screen.getByLabelText("名称"), "我的搜索");
    await user.type(screen.getByLabelText("URL"), "https://s.example.com/search");
    fireEvent.change(screen.getByLabelText("请求体模板"), {
      target: { value: '{"q":"{{query}}","n":{{count}}}' },
    });
    await user.type(screen.getByLabelText("结果列表路径"), "items");
    await user.type(screen.getByLabelText("标题路径"), "title");
    await user.type(screen.getByLabelText("链接路径"), "url");
    await user.type(screen.getByLabelText("API Key"), "k");
    await user.click(screen.getByRole("button", { name: "保存" }));

    await waitFor(() =>
      expect(onSubmit).toHaveBeenCalledWith({
        name: "我的搜索",
        apiKey: "k",
        endpoint: {
          method: "POST",
          url: "https://s.example.com/search",
          auth: { header: "Authorization", prefix: "Bearer " },
          bodyTemplate: '{"q":"{{query}}","n":{{count}}}',
          paths: { list: "items", title: "title", url: "url" },
        },
      }),
    );
  });

  it("keeps GET without a body template", async () => {
    const onSubmit = vi.fn(() => Promise.resolve());
    const user = userEvent.setup();
    render(<CustomSearchSourceForm onSubmit={onSubmit} onCancel={vi.fn()} />);

    await user.type(screen.getByLabelText("名称"), "G");
    await user.click(screen.getByRole("combobox", { name: "请求方法" }));
    await user.click(await screen.findByRole("option", { name: "GET" }));
    await user.type(screen.getByLabelText("URL"), "https://s.example.com/s?q={{query}}");
    await user.type(screen.getByLabelText("结果列表路径"), "items");
    await user.type(screen.getByLabelText("标题路径"), "title");
    await user.type(screen.getByLabelText("链接路径"), "url");
    await user.click(screen.getByRole("button", { name: "保存" }));

    await waitFor(() => expect(onSubmit).toHaveBeenCalled());
    const call = onSubmit.mock.calls[0] as unknown[] | undefined;
    const input = call?.[0] as { endpoint: { method: string; bodyTemplate?: string } };
    expect(input.endpoint.method).toBe("GET");
    expect(input.endpoint.bodyTemplate).toBeUndefined();
  });
});

describe("CustomSearchSources", () => {
  it("deletes a custom source after confirmation", async () => {
    const calls: Array<{ method: string; url: string }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        calls.push({ method: String(init?.method ?? "GET"), url: String(input) });
        return new Response(JSON.stringify({ ...VIEW, custom: [] }), { status: 200 });
      }),
    );
    const onChange = vi.fn();
    const user = userEvent.setup();
    render(<CustomSearchSources sources={VIEW.custom} onChange={onChange} onError={vi.fn()} />);

    await user.click(screen.getByRole("button", { name: "删除 我的搜索" }));
    await user.click(screen.getByRole("button", { name: "确认删除" }));

    await waitFor(() => expect(calls[0]?.method).toBe("DELETE"));
    expect(calls[0]?.url).toContain("/config/web-search/custom/mine");
    expect(onChange).toHaveBeenCalled();
  });
});
