import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { ToolCallCard } from '../ToolCallCard';
import type { ConversationToolCall } from '@voltojs/sdk/sse';

const call: ConversationToolCall = {
  id: '1',
  name: 'web_search',
  args: { query: 'volto agent' },
  result: '1. A — https://a.example',
  durationMs: 210,
  search: {
    sourceId: 'glm',
    sourceLabel: 'GLM',
    query: 'volto agent',
    count: 2,
    durationMs: 210,
    hits: [
      { title: 'A', url: 'https://a.example', snippet: 'SA' },
      { title: 'B', url: 'https://b.example', snippet: 'SB', publishedAt: '2026-02-02' },
    ],
  },
};

describe('ToolCallCard web search', () => {
  it('renders the source and each hit without expanding', () => {
    render(<ToolCallCard call={call} label="volto agent" />);
    expect(screen.getByText(/GLM/)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'A' })).toHaveAttribute('href', 'https://a.example');
    expect(screen.getByText(/SB/)).toBeInTheDocument();
    expect(screen.getByText(/2026-02-02/)).toBeInTheDocument();
  });

  it('renders no search block when the call carries none', () => {
    render(<ToolCallCard call={{ id: '2', name: 'web_search', args: { query: 'q' }, result: 'x' }} label="q" />);
    expect(screen.queryByRole('link', { name: 'A' })).toBeNull();
  });
});
