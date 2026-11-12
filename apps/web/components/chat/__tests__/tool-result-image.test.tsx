import { describe, expect, it } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ToolCallCard } from "../ToolCallCard";

const SCREENSHOT = {
  attachmentId: "att-shot",
  mediaType: "image/png",
  width: 1280,
  height: 800,
};

describe("ToolCallCard result images", () => {
  it("shows a screenshot result and opens it in a dialog", async () => {
    const user = userEvent.setup();
    render(
      <ToolCallCard
        sessionId="session-1"
        call={{
          id: "c-shot",
          name: "browser_screenshot",
          args: {},
          result: "Screenshot (1280x800)",
          images: [SCREENSHOT],
        }}
      />,
    );

    const thumb = screen.getByRole("button", { name: "查看截图" });
    const thumbImage = thumb.querySelector("img");
    expect(thumbImage).toHaveAttribute(
      "src",
      "/gateway/attachments/att-shot?sessionId=session-1",
    );

    await user.click(thumb);
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByRole("img", { name: "截图" })).toHaveAttribute(
      "src",
      "/gateway/attachments/att-shot?sessionId=session-1",
    );
  });

  it("degrades to a named placeholder without a session", () => {
    render(
      <ToolCallCard
        call={{
          id: "c-shot",
          name: "browser_screenshot",
          args: {},
          result: "Screenshot",
          images: [SCREENSHOT],
        }}
      />,
    );
    expect(screen.getByText(/att-shot/)).toBeInTheDocument();
  });
});
