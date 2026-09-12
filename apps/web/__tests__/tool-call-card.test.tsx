/**
 * The task tool-call card: sub-agent calls surface a "查看执行过程"
 * affordance (clickable while the card is collapsed) plus a running
 * elapsed counter; plain (non-sub-agent) calls render exactly as before.
 */

import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { ToolCallCard } from '@/components/chat/ToolCallCard';

describe('ToolCallCard', () => {
  it("renders the open-pane affordance for sub-agent calls and fires onOpenSubagent", async () => {
    const onOpenSubagent = vi.fn();
    render(
      <ToolCallCard
        call={{ id: "c1", name: "task", args: { message: "go" }, childSessionId: "s-sub-0", startedAt: Date.now() - 3000 }}
        onOpenSubagent={onOpenSubagent}
      />,
    );
    expect(screen.getByText("运行中")).toBeDefined();
    const button = screen.getByRole("button", { name: /查看执行过程/ });
    fireEvent.click(button);
    expect(onOpenSubagent).toHaveBeenCalledWith("s-sub-0");
  });

  it("plain tool calls keep the existing rendering (no affordance, no ticking)", () => {
    render(<ToolCallCard call={{ id: "c2", name: "read_file", args: {} }} />);
    expect(screen.queryByRole("button", { name: /查看执行过程/ })).toBeNull();
  });
});
