import { afterEach, describe, expect, it } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { TrajectoryDrawer } from "../TrajectoryDrawer";
import { useTrajectoryDrawerStore } from "@/stores/trajectory-drawer-store";
import type { TrajectoryRow } from "@volto/sdk/sse";

const ROW: TrajectoryRow = {
  index: 1,
  id: "c-shot",
  kind: "tool",
  turn: 1,
  summary: "browser_screenshot({})",
  startedAt: 1,
  outputDetail: "Screenshot (1280x800)",
  images: [
    {
      attachmentId: "att-shot",
      mediaType: "image/png",
      width: 1280,
      height: 800,
    },
  ],
};

afterEach(() => {
  useTrajectoryDrawerStore.setState({ row: null, projectId: undefined, sessionId: undefined });
});

const REQUEST_ROW: TrajectoryRow = {
  index: 2,
  id: "a-request",
  kind: "assistant",
  turn: 1,
  step: 1,
  summary: "hi",
  startedAt: 1,
  requestManifest: {
    headerHash: "h1",
    model: "deepseek-v4.1-flash-1017",
    toolNames: ["browser_screenshot"],
    messages: [
      { id: "u1", role: "user", blocks: ["text"], textChars: 5 },
      { id: "a1", role: "assistant", blocks: ["tool_use"], toolUseIds: ["c1"] },
    ],
  },
};

describe("TrajectoryDrawer result images", () => {
  it("shows a screenshot in the overview and opens the dialog on click", async () => {
    useTrajectoryDrawerStore.setState({ sessionId: "session-1", projectId: null });
    const user = userEvent.setup();
    render(<TrajectoryDrawer row={ROW} open onOpenChange={() => {}} />);

    const thumb = await screen.findByRole("button", { name: "查看截图" });
    expect(thumb.querySelector("img")).toHaveAttribute(
      "src",
      "/gateway/attachments/att-shot?sessionId=session-1",
    );

    await user.click(thumb);
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByRole("img", { name: "截图" })).toBeInTheDocument();
  });

  it("renders the request manifest tab for an assistant step", async () => {
    const user = userEvent.setup();
    useTrajectoryDrawerStore.setState({ sessionId: "session-1", projectId: null });
    render(<TrajectoryDrawer row={REQUEST_ROW} open onOpenChange={() => {}} />);

    await user.click(screen.getByRole("tab", { name: "请求" }));
    expect(await screen.findByText("deepseek-v4.1-flash-1017")).toBeInTheDocument();
    expect(screen.getByText("h1")).toBeInTheDocument();
    expect(screen.getByText(/browser_screenshot/)).toBeInTheDocument();
    expect(screen.getByText(/c1/)).toBeInTheDocument();
  });
});
