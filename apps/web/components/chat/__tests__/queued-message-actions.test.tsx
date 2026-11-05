/**
 * Task 14: inline edit / retract actions on a queued (not yet delivered)
 * message bubble.
 *
 * Renders the real feed path — useConversation's steering fold feeding
 * MessageList — and stubs only the network layer (`fetch`), so every
 * convergence assertion below goes through the actual event fold:
 * `steering_edited` rewrites the bubble in place, `steering_removed` drops
 * it, `steering_delivered` hides the actions. No optimistic local mutation
 * is asserted: after a successful POST the bubble keeps its old content
 * until the receipt event lands.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import type { TranscriptEventInput } from '@volto/sdk/sse';
import { MessageList } from '../MessageList';
import { useConversation } from '@/hooks/use-conversation';
import { useChatStore } from '@/stores/chat-store';
import { useSessionStore } from '@/stores/session-store';

// jsdom has no layout; the list scrolls its bottom anchor into view.
Element.prototype.scrollIntoView ??= () => {};

const fetchMock = vi.fn();

/** The real feed the ChatPanel renders, minus the panel chrome. */
function Feed() {
  const { entries } = useConversation();
  return <MessageList entries={entries} />;
}

function queued(content: string): TranscriptEventInput {
  return {
    time: 1,
    type: 'steering_queued',
    data: { id: 'q1', content },
    turn: 1,
  };
}

/** Seeds both stores the way an open session has them (buffer == current). */
function seed(events: TranscriptEventInput[]) {
  useSessionStore.setState({ currentSessionId: 's1', sessions: [] });
  useChatStore.setState({
    events,
    deltas: [],
    notices: [],
    currentSessionId: 's1',
    isGenerating: false,
    subagents: {},
  });
}

function okResponse() {
  return { ok: true, status: 200, json: async () => ({ ok: true }) };
}

beforeEach(() => {
  vi.clearAllMocks();
  fetchMock.mockResolvedValue(okResponse());
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('queued message actions', () => {
  it('queued bubble shows edit and remove actions', () => {
    seed([queued('原始内容')]);
    render(<Feed />);

    expect(screen.getByText('原始内容')).toBeInTheDocument();
    // Spec §4.6: the queued message shows up marked "排队中" right away.
    expect(screen.getByText('排队中')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '编辑' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '撤回' })).toBeInTheDocument();
  });

  it('editing posts the update and the bubble content converges on the steering_edited event', async () => {
    seed([queued('原始内容')]);
    render(<Feed />);

    fireEvent.click(screen.getByRole('button', { name: '编辑' }));
    fireEvent.change(screen.getByRole('textbox'), {
      target: { value: '修改后的内容' },
    });
    fireEvent.click(screen.getByRole('button', { name: '保存' }));

    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        '/gateway/messages/queue',
        expect.objectContaining({
          method: 'POST',
          body: JSON.stringify({
            sessionId: 's1',
            id: 'q1',
            action: { kind: 'edit', content: '修改后的内容' },
          }),
        }),
      ),
    );
    // No optimistic echo: the editor closes but the bubble keeps its old
    // content until the server's steering_edited receipt folds in.
    expect(screen.queryByText('修改后的内容')).toBeNull();
    expect(screen.getByText('原始内容')).toBeInTheDocument();

    act(() => {
      useChatStore.getState().pushEvent({
        time: 2,
        type: 'steering_edited',
        data: { id: 'q1', content: '修改后的内容' },
        turn: 1,
      });
    });

    expect(screen.getByText('修改后的内容')).toBeInTheDocument();
    expect(screen.queryByText('原始内容')).toBeNull();
  });

  it('removing posts the removal and the bubble disappears', async () => {
    seed([queued('原始内容')]);
    render(<Feed />);

    fireEvent.click(screen.getByRole('button', { name: '撤回' }));

    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        '/gateway/messages/queue',
        expect.objectContaining({
          method: 'POST',
          body: JSON.stringify({
            sessionId: 's1',
            id: 'q1',
            action: { kind: 'remove' },
          }),
        }),
      ),
    );
    // No optimistic removal either — the bubble waits for steering_removed.
    expect(screen.getByText('原始内容')).toBeInTheDocument();

    act(() => {
      useChatStore.getState().pushEvent({
        time: 2,
        type: 'steering_removed',
        data: { id: 'q1' },
        turn: 1,
      });
    });

    expect(screen.queryByText('原始内容')).toBeNull();
    expect(screen.queryByRole('button', { name: '撤回' })).toBeNull();
  });

  it('actions are hidden once the message is delivered', () => {
    seed([
      queued('原始内容'),
      { time: 2, type: 'steering_delivered', data: { ids: ['q1'] }, turn: 1 },
    ]);
    render(<Feed />);

    // Delivery wins: the bubble stays, the actions are gone with it.
    expect(screen.getByText('原始内容')).toBeInTheDocument();
    expect(screen.queryByText('排队中')).toBeNull();
    expect(screen.queryByRole('button', { name: '编辑' })).toBeNull();
    expect(screen.queryByRole('button', { name: '撤回' })).toBeNull();
  });

  it('a 409 shows the gone notice', async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      status: 409,
      json: async () => ({ error: 'gone', code: 'QUEUE_ITEM_GONE' }),
    });
    seed([queued('原始内容')]);
    render(<Feed />);

    fireEvent.click(screen.getByRole('button', { name: '撤回' }));

    await waitFor(() =>
      expect(
        screen.getByText('该排队消息已不可用，可能已送达'),
      ).toBeInTheDocument(),
    );
  });
});
