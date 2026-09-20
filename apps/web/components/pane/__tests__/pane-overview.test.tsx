// 「+」菜单/空面板的类目列表：当前会话存在已保存计划时提供「计划」入口，
// 关闭计划标签后经它可重新打开（tab id = sessionId，与自动打开去重）。
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import { PaneCategoryItems } from "../PaneOverview";
import { useSessionStore } from "@/stores/session-store";
import { usePaneStore } from "@/stores/pane-store";

vi.mock("@/lib/git-api", () => ({
  fetchGitSummary: vi.fn(async () => null),
}));

const fetchPlan = vi.hoisted(() => vi.fn());
vi.mock("@/lib/sessions-api", () => ({ fetchPlan }));

beforeEach(() => {
  fetchPlan.mockReset();
  usePaneStore.setState({ tabs: [], activeTabId: null, open: false, hidden: false });
  useSessionStore.setState({ currentSessionId: null } as never);
});

describe("PaneCategoryItems — 计划入口", () => {
  it("会话有计划时提供入口，点击重开计划标签（kind/id/sessionId 与自动打开一致）", async () => {
    fetchPlan.mockResolvedValue({ content: "# p", updatedAt: 1 });
    useSessionStore.setState({ currentSessionId: "sess-1" } as never);
    render(<PaneCategoryItems projectId="p1" />);

    const entry = await screen.findByRole("button", { name: /计划/ });
    fireEvent.click(entry);

    const tabs = usePaneStore.getState().tabs;
    expect(tabs).toHaveLength(1);
    expect(tabs[0]).toMatchObject({ kind: "plan", id: "sess-1", sessionId: "sess-1" });
    expect(usePaneStore.getState().activeTabId).toBe("sess-1");
  });

  it("会话无计划时不显示入口", async () => {
    fetchPlan.mockResolvedValue(null);
    useSessionStore.setState({ currentSessionId: "sess-1" } as never);
    render(<PaneCategoryItems projectId="p1" />);

    await waitFor(() => expect(fetchPlan).toHaveBeenCalledWith("sess-1"));
    expect(screen.queryByRole("button", { name: /计划/ })).not.toBeInTheDocument();
  });

  it("无活动会话时不探测也不显示入口", () => {
    render(<PaneCategoryItems projectId="p1" />);
    expect(fetchPlan).not.toHaveBeenCalled();
    expect(screen.queryByRole("button", { name: /计划/ })).not.toBeInTheDocument();
  });
});
