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
});
