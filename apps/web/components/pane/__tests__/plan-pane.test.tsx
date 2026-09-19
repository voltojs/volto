// apps/web/components/pane/__tests__/plan-pane.test.tsx
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { PlanPane } from "../PlanPane";

describe("PlanPane", () => {
  it("renders the plan markdown and gates the execute button", () => {
    render(<PlanPane sessionId="s1" content="# 计划\n1. 第一步" canExecute onExecute={vi.fn()} />);
    expect(screen.getByTestId("plan-doc")).toHaveTextContent("第一步");
    expect(screen.getByRole("button", { name: "按计划执行" })).toBeEnabled();
  });

  it("executing switches mode and sends the execution message", () => {
    const onExecute = vi.fn();
    render(<PlanPane sessionId="s1" content="# p" canExecute onExecute={onExecute} />);
    fireEvent.click(screen.getByRole("button", { name: "按计划执行" }));
    expect(onExecute).toHaveBeenCalledOnce();
  });

  it("disables execute while a turn is generating", () => {
    render(<PlanPane sessionId="s1" content="# p" canExecute={false} onExecute={vi.fn()} />);
    expect(screen.getByRole("button", { name: "按计划执行" })).toBeDisabled();
  });
});
