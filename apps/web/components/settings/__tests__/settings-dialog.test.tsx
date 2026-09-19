import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { SettingsDialog } from "../SettingsDialog";

function stubFetch() {
  const urls: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      urls.push(url);
      // Route by endpoint with the shape each panel expects — the models
      // tab mounts on open and crashes the whole dialog tree if its
      // endpoints return the wrong shape (a bare { } swallowed `.filter`).
      if (url.includes("/agents")) {
        return new Response(JSON.stringify({ agents: [] }), { status: 200 });
      }
      if (url.includes("/catalog/providers") || url.includes("/providers")) {
        return new Response(JSON.stringify([]), { status: 200 });
      }
      return new Response(JSON.stringify({ tools: [] }), { status: 200 });
    }),
  );
  return urls;
}

afterEach(() => vi.unstubAllGlobals());

describe("SettingsDialog", () => {
  it("orders tabs 通用设置 → 模型配置 → 子代理", () => {
    stubFetch();
    render(<SettingsDialog open onOpenChange={() => {}} />);
    const labels = screen.getAllByRole("tab").map((tab) => tab.textContent);
    expect(labels).toEqual(["通用设置", "模型配置", "子代理"]);
  });

  it("scopes the subagents panel to the current workspace's project", async () => {
    const urls = stubFetch();
    const user = userEvent.setup();
    render(<SettingsDialog open onOpenChange={() => {}} projectId="proj-1" />);
    // The agents list fetch only fires once the subagents tab mounts its panel.
    await user.click(screen.getByRole("tab", { name: "子代理" }));
    await screen.findByText("新建子代理");
    const agentsCalls = urls.filter((url) => url.includes("/agents"));
    expect(agentsCalls.length).toBeGreaterThan(0);
    expect(agentsCalls.every((url) => url.includes("projectId=proj-1"))).toBe(true);
  });
});
