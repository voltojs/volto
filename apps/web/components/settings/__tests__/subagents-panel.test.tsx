import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { SubagentsPanel } from "../SubagentsPanel";
import type { RoutingTier } from "@/lib/routing-tiers-api";
import type { AgentEntry } from "@/lib/agents-api";
import { useConfigStore } from "@/stores/config-store";

// jsdom does not implement the pointer-capture / scroll APIs Base UI's
// Select uses internally; stub them so the popup can open in tests.
Element.prototype.hasPointerCapture ??= () => false;
Element.prototype.setPointerCapture ??= () => {};
Element.prototype.releasePointerCapture ??= () => {};
Element.prototype.scrollIntoView ??= () => {};

const AGENTS: AgentEntry[] = [
  { id: "project:searcher", name: "searcher", description: "finds things", scope: "project", readOnly: false, shadowed: false, filePath: "/p/.volto/agents/searcher.md", spec: { name: "searcher" } },
  { id: "user:searcher", name: "searcher", description: "older copy", scope: "user", readOnly: false, shadowed: true, filePath: "/h/.volto/agents/searcher.md", spec: { name: "searcher" } },
  { id: "plugin:builtin", name: "builtin", description: "from a plugin", scope: "plugin", readOnly: true, shadowed: false, spec: { name: "builtin" } },
];

const TIERS: RoutingTier[] = [
  {
    id: "premium",
    label: "最强",
    description: "复杂任务",
    target: { providerId: "v1", modelId: "m2" },
  },
  {
    id: "economy",
    label: "省成本",
    description: "日常任务",
    target: { providerId: "v1", modelId: "m1" },
  },
];

function stub(agents = AGENTS, tiers: RoutingTier[] = []) {
  vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request) => {
    const url = String(input);
    if (url.includes("/agents")) return new Response(JSON.stringify({ agents }), { status: 200 });
    if (url.includes("/config/routing-tiers")) return new Response(JSON.stringify({ tiers }), { status: 200 });
    return new Response(JSON.stringify({ tools: [] }), { status: 200 });
  }));
}
afterEach(() => {
  vi.unstubAllGlobals();
  useConfigStore.setState({ providers: [] });
});

describe("SubagentsPanel", () => {
  it("shows a source badge for every entry", async () => {
    stub();
    render(<SubagentsPanel projectId={null} />);
    await waitFor(() => expect(screen.getByText("searcher")).toBeInTheDocument());
    expect(screen.getByText(/项目/)).toBeInTheDocument();
    expect(screen.getByText(/用户/)).toBeInTheDocument();
    expect(screen.getByText(/插件/)).toBeInTheDocument();
  });

  it("warns that a shadowed definition has no effect", async () => {
    stub();
    render(<SubagentsPanel projectId={null} />);
    await waitFor(() => expect(screen.getByText("older copy")).toBeInTheDocument());
    // The warning must say it is inactive — a badge alone does not explain
    // why editing this entry changes nothing.
    expect(screen.getByText(/被.*覆盖|不生效/)).toBeInTheDocument();
  });

  it("disables edit and delete on a read-only entry", async () => {
    stub();
    render(<SubagentsPanel projectId={null} />);
    await waitFor(() => expect(screen.getByText("builtin")).toBeInTheDocument());
    const row = screen.getByText("builtin").closest("[data-agent-row]")!;
    expect(row.querySelector("[data-action='edit']")).toHaveAttribute("disabled");
    expect(row.querySelector("[data-action='delete']")).toHaveAttribute("disabled");
  });

  it("shows the routing tier a sub-agent is pinned to, or inheritance", async () => {
    stub(
      [
        { ...AGENTS[0]!, spec: { ...AGENTS[0]!.spec, model: "premium" } },
        { ...AGENTS[1]!, spec: { ...AGENTS[1]!.spec, model: "gone" } },
        AGENTS[2]!,
      ],
      TIERS,
    );
    render(<SubagentsPanel projectId={null} />);
    await waitFor(() => expect(screen.getByText("路由：最强")).toBeInTheDocument());
    expect(screen.getByText("已失效档位:gone")).toBeInTheDocument();
    // The plugin entry carries no model and must read as inheritance.
    expect(screen.getByText("继承主对话")).toBeInTheDocument();
  });

  it("names the provider in the model tooltip instead of its id", async () => {
    useConfigStore.setState({
      providers: [{ id: "v1", name: "DeepSeek" } as never],
    });
    stub([{ ...AGENTS[0]!, spec: { ...AGENTS[0]!.spec, model: "premium" } }], TIERS);
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    render(<SubagentsPanel projectId={null} />);
    await waitFor(() => expect(screen.getByText("路由：最强")).toBeInTheDocument());

    await user.hover(screen.getByText("路由：最强"));
    expect(await screen.findByText(/DeepSeek \/ m2/)).toBeInTheDocument();
  });

  it("renders an empty state rather than a blank panel", async () => {
    stub([]);
    render(<SubagentsPanel projectId={null} />);
    await waitFor(() => expect(screen.getByText(/还没有.*子代理|尚未定义/)).toBeInTheDocument());
  });

  it("passes the fetched routing tiers down to the form's model dropdown", async () => {
    stub(AGENTS, TIERS);
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    render(<SubagentsPanel projectId={null} />);
    await waitFor(() => expect(screen.getByText("searcher")).toBeInTheDocument());
    await user.click(screen.getByRole("button", { name: /新建子代理/ }));
    await user.click(screen.getByRole("combobox", { name: /model/ }));
    const options = await screen.findAllByRole("option");
    expect(options.map((option) => option.textContent)).toEqual([
      "继承主对话",
      "最强",
      "省成本",
    ]);
  });

  it("never marks a tier stale while the tier fetch has not settled", async () => {
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      // Pending forever: the panel sees no tier list yet and must not read
      // that window as "the table is empty".
      if (url.includes("/config/routing-tiers")) return new Promise<Response>(() => {});
      if (url.includes("/agents")) {
        const agents = [{ ...AGENTS[0]!, spec: { name: "searcher", model: "economy" } }];
        return new Response(JSON.stringify({ agents }), { status: 200 });
      }
      return new Response(JSON.stringify({ tools: [] }), { status: 200 });
    }));
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    render(<SubagentsPanel projectId={null} />);
    await waitFor(() => expect(screen.getByText("searcher")).toBeInTheDocument());
    await user.click(screen.getByRole("button", { name: /编辑 searcher/ }));
    // spec.model names a valid tier that simply has not been fetched yet;
    // showing it as stale would push the user toward dropping the reference.
    expect(screen.queryByText(/已失效档位/)).not.toBeInTheDocument();
    expect(screen.getByRole("combobox", { name: /model/ })).toBeInTheDocument();
  });

  it("keeps the form usable when the tier fetch fails", async () => {
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes("/config/routing-tiers")) {
        return new Response(JSON.stringify({ error: "boom" }), { status: 500 });
      }
      if (url.includes("/agents")) return new Response(JSON.stringify({ agents: AGENTS }), { status: 200 });
      return new Response(JSON.stringify({ tools: [] }), { status: 200 });
    }));
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    render(<SubagentsPanel projectId={null} />);
    await waitFor(() => expect(screen.getByText("searcher")).toBeInTheDocument());
    // A failed tier load is silent: the form opens and degrades to the
    // inherit-only dropdown instead of blocking on the missing list.
    await user.click(screen.getByRole("button", { name: /新建子代理/ }));
    await user.click(screen.getByRole("combobox", { name: /model/ }));
    const options = await screen.findAllByRole("option");
    expect(options.map((option) => option.textContent)).toEqual(["继承主对话"]);
  });
});
