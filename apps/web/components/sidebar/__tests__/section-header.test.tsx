import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { SectionHeader } from "../SectionHeader";

Element.prototype.hasPointerCapture ??= () => false;
Element.prototype.setPointerCapture ??= () => {};
Element.prototype.releasePointerCapture ??= () => {};
Element.prototype.scrollIntoView ??= () => {};

const options = [
  { value: "manual", label: "手动排序" },
  { value: "recent", label: "最近活跃" },
];

describe("SectionHeader", () => {
  it("exposes collapse state and toggles on click", async () => {
    const onToggleCollapsed = vi.fn();
    render(<SectionHeader title="置顶" count={2} collapsed={false} onToggleCollapsed={onToggleCollapsed} sort={{ value: "manual", options, onChange: vi.fn() }} />);
    const toggle = screen.getByRole("button", { name: "收起置顶" });
    expect(toggle).toHaveAttribute("aria-expanded", "true");
    await userEvent.click(toggle);
    expect(onToggleCollapsed).toHaveBeenCalledTimes(1);
    expect(screen.getByText("2 个")).toBeInTheDocument();
  });

  it("reports aria-expanded=false when collapsed", () => {
    render(<SectionHeader title="工作区" collapsed onToggleCollapsed={vi.fn()} sort={{ value: "manual", options, onChange: vi.fn() }} />);
    expect(screen.getByRole("button", { name: "展开工作区" })).toHaveAttribute("aria-expanded", "false");
  });

  it("lists sort options and reports the chosen one", async () => {
    const onChange = vi.fn();
    render(<SectionHeader title="置顶" collapsed={false} onToggleCollapsed={vi.fn()} sort={{ value: "manual", options, onChange }} />);
    await userEvent.click(screen.getByRole("button", { name: "排序方式" }));
    await userEvent.click(await screen.findByRole("menuitemradio", { name: "最近活跃" }));
    expect(onChange).toHaveBeenCalledWith("recent");
  });

  it("renders the trailing action slot", () => {
    render(<SectionHeader title="工作区" collapsed={false} onToggleCollapsed={vi.fn()} sort={{ value: "manual", options, onChange: vi.fn() }} action={<button type="button">添加工作区</button>} />);
    expect(screen.getByRole("button", { name: "添加工作区" })).toBeInTheDocument();
  });
});