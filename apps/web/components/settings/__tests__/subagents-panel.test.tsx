import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { SubagentsPanel } from "../SubagentsPanel";

const AGENTS = [
  { id: "project:searcher", name: "searcher", description: "finds things", scope: "project", readOnly: false, shadowed: false, filePath: "/p/.volto/agents/searcher.md", spec: { name: "searcher" } },
  { id: "user:searcher", name: "searcher", description: "older copy", scope: "user", readOnly: false, shadowed: true, filePath: "/h/.volto/agents/searcher.md", spec: { name: "searcher" } },
  { id: "plugin:builtin", name: "builtin", description: "from a plugin", scope: "plugin", readOnly: true, shadowed: false, spec: { name: "builtin" } },
];

function stub(agents = AGENTS) {
  vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request) => {
    const url = String(input);
    if (url.includes("/agents")) return new Response(JSON.stringify({ agents }), { status: 200 });
    return new Response(JSON.stringify({ tools: [] }), { status: 200 });
  }));
}
afterEach(() => { vi.unstubAllGlobals(); });

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

  it("renders an empty state rather than a blank panel", async () => {
    stub([]);
    render(<SubagentsPanel projectId={null} />);
    await waitFor(() => expect(screen.getByText(/还没有.*子代理|尚未定义/)).toBeInTheDocument());
  });
});
