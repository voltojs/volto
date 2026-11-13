/**
 * Task 16: queued messages render in a dock above the composer (spec D16),
 * never as conversation bubbles.
 *
 * Renders the real feed path — useConversation's steering fold feeding
 * MessageList and QueuedDock from the SAME `entries` (the isomorphism the
 * dock's spec requires) — and stubs only the network layer (`fetch`), so
 * every convergence assertion below goes through the actual event fold:
 * `steering_edited` rewrites the dock entry in place, `steering_removed`
 * drops it, `steering_delivered` moves it into the conversation flow.
 * No optimistic local mutation is asserted: after a successful POST the
 * dock keeps its old content until the receipt event lands.
 *
 * Same-nature migration of Task 14's queued-message-actions tests — the
 * conversation-flow gating, the 409 notice and the no-optimistic
 * assertions are preserved here.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  render,
  screen,
  fireEvent,
  waitFor,
  act,
  within,
} from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { TranscriptEventInput } from '@voltojs/sdk/sse';
import { MessageList } from '../MessageList';
import { QueuedDock } from '../QueuedDock';
import { TooltipProvider } from '@/components/ui/tooltip';
import { useConversation } from '@/hooks/use-conversation';
import { useChatStore } from '@/stores/chat-store';
import { useSessionStore } from '@/stores/session-store';
import { GATEWAY_URL_KEY, gatewayUrl, resetGatewayBaseForTest } from '@/lib/gateway-base';

// jsdom has no layout: the feed scrolls its bottom anchor into view, and the
// attachment tooltip is pointer-driven, so Base UI needs the pointer-capture
// shims (same set as the sidebar's tooltip tests).
Element.prototype.scrollIntoView ??= () => {};
Element.prototype.hasPointerCapture ??= () => false;
Element.prototype.setPointerCapture ??= () => {};
Element.prototype.releasePointerCapture ??= () => {};

const fetchMock = vi.fn();

/** The conversation flow alone — the surface that must hide queued entries. */
function Feed() {
  const { entries } = useConversation();
  return <MessageList entries={entries} />;
}

/** Both render surfaces of one projection, wired like ChatPanel wires them. */
function Panel() {
  const { entries } = useConversation();
  return (
    <TooltipProvider delay={0}>
      <div data-testid="conversation">
        <MessageList entries={entries} />
      </div>
      <QueuedDock entries={entries} />
    </TooltipProvider>
  );
}

type QueuedContent = TranscriptEventInput<'steering_queued'>['data']['content'];

function queued(
  id: string,
  content: QueuedContent,
  time: number,
): TranscriptEventInput {
  return { time, type: 'steering_queued', data: { id, content }, turn: 1 };
}

/** A queued entry whose content carries an image block after its text. */
function queuedWithImage(id: string, text: string, time: number): TranscriptEventInput {
  return queued(
    id,
    [
      { type: 'text', text },
      {
        type: 'image',
        source: { type: 'ref', id: `att-${id}`, mediaType: 'image/png' },
        width: 8,
        height: 8,
      },
    ],
    time,
  );
}

function user(content: string, time: number, turn: number): TranscriptEventInput {
  return { time, type: 'user_message', data: { content }, turn };
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

// A fixed absolute base makes the fetch assertions read as real requests;
// the resolver itself is covered by lib/__tests__/gateway-base.test.ts.
beforeEach(() => {
  localStorage.setItem(GATEWAY_URL_KEY, 'http://gw.test');
  resetGatewayBaseForTest();
  vi.clearAllMocks();
  fetchMock.mockResolvedValue(okResponse());
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('queued dock', () => {
  it('conversation flow hides queued entries until delivered', () => {
    seed([
      user('第一条', 1, 1),
      queued('q1', '排队内容', 2),
      user('第三条', 3, 2),
    ]);
    render(<Feed />);

    // Gating: the conversation renders only delivered entries.
    expect(screen.queryByText('排队内容')).toBeNull();
    expect(screen.getByText('第一条')).toBeInTheDocument();
    expect(screen.getByText('第三条')).toBeInTheDocument();

    act(() => {
      useChatStore.getState().pushEvent({
        time: 4,
        type: 'steering_delivered',
        data: { ids: ['q1'] },
        turn: 1,
      });
    });

    // Delivery wins: the entry shows up at its SEND position — between the
    // messages that were already there when it was queued.
    expect(screen.getByText('排队内容')).toBeInTheDocument();
    const text = document.body.textContent ?? '';
    expect(text.indexOf('第一条')).toBeLessThan(text.indexOf('排队内容'));
    expect(text.indexOf('排队内容')).toBeLessThan(text.indexOf('第三条'));
  });

  it('dock lists queued messages FIFO with attachment chip and single-line content', async () => {
    seed([
      queued('q1', '先发的排队消息', 1),
      queuedWithImage('q2', '带图的排队消息', 2),
    ]);
    render(<Panel />);

    // Neither entry leaks into the conversation flow while queued.
    const conversation = screen.getByTestId('conversation');
    expect(within(conversation).queryByText('先发的排队消息')).toBeNull();

    // FIFO: dock order is the send order.
    const dock = screen.getByTestId('queued-dock');
    const items = within(dock).getAllByTestId('queued-item');
    expect(items).toHaveLength(2);
    expect(items[0]).toHaveTextContent('先发的排队消息');
    expect(items[1]).toHaveTextContent('带图的排队消息');
    expect(items[0]).toHaveTextContent('排队中');

    // Attachment chip: count + icon, only on the entry that has non-text
    // blocks — the plain-text entry carries no chip.
    expect(within(items[0]!).queryByTestId('queued-attachment-chip')).toBeNull();
    const chip = within(items[1]!).getByTestId('queued-attachment-chip');
    expect(chip).toHaveTextContent('1');
    expect(chip.querySelector('svg')).not.toBeNull();

    // Single-line content: the truncate utility (ellipsis + no wrap).
    expect(
      within(items[0]!).getByTestId('queued-content').className,
    ).toContain('truncate');

    // Hovering the chip opens the popup listing the attachments.
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    await user.hover(chip);
    await waitFor(() =>
      expect(document.querySelector('[data-slot="tooltip-content"]')).not.toBeNull(),
    );
    const popup = document.querySelector('[data-slot="tooltip-content"]')!;
    expect(popup).toHaveTextContent('image/png');
  });

  it('dock edit uses a multiline editor and saves text', async () => {
    seed([queued('q1', '原始内容', 1)]);
    render(<Panel />);

    fireEvent.click(screen.getByRole('button', { name: '编辑' }));
    const editor = screen.getByRole('textbox') as HTMLTextAreaElement;
    // Multiline editor — a textarea, not a single-line input.
    expect(editor.tagName).toBe('TEXTAREA');
    expect(editor).toHaveValue('原始内容');

    // Enter does NOT submit: the dock editor is a plain textarea (newline),
    // saving is the Save button's job — deliberately unlike the composer's
    // Enter-to-send convention.
    fireEvent.keyDown(editor, { key: 'Enter' });
    expect(fetchMock).not.toHaveBeenCalled();

    fireEvent.change(editor, { target: { value: '修改后的内容' } });
    fireEvent.click(screen.getByRole('button', { name: '保存' }));

    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        gatewayUrl('/messages/queue'),
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
    // No optimistic echo: the editor closes but the dock entry keeps its
    // old content until the server's steering_edited receipt folds in.
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

  it('dock edit disables save while the draft is trim-empty', () => {
    seed([queued('q1', '原始内容', 1)]);
    render(<Panel />);

    fireEvent.click(screen.getByRole('button', { name: '编辑' }));
    fireEvent.change(screen.getByRole('textbox'), { target: { value: '   ' } });

    expect(screen.getByRole('button', { name: '保存' })).toBeDisabled();
    expect(screen.getByText('消息内容不能为空')).toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('retract removes the entry from the dock', async () => {
    seed([queued('q1', '原始内容', 1)]);
    render(<Panel />);

    fireEvent.click(screen.getByRole('button', { name: '撤回' }));

    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        gatewayUrl('/messages/queue'),
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
    // No optimistic removal either — the dock entry waits for steering_removed.
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

  it('delivered entries leave the dock', () => {
    seed([queued('q1', '排队内容', 1)]);
    render(<Panel />);

    expect(screen.getByTestId('queued-dock')).toBeInTheDocument();
    expect(
      within(screen.getByTestId('conversation')).queryByText('排队内容'),
    ).toBeNull();

    act(() => {
      useChatStore.getState().pushEvent({
        time: 2,
        type: 'steering_delivered',
        data: { ids: ['q1'] },
        turn: 1,
      });
    });

    // The dock renders nothing once its queue is empty, and the entry is
    // back in the conversation flow (the pair of the first test).
    expect(screen.queryByTestId('queued-dock')).toBeNull();
    expect(
      within(screen.getByTestId('conversation')).getByText('排队内容'),
    ).toBeInTheDocument();
  });

  it('a 409 shows the gone notice', async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      status: 409,
      json: async () => ({ error: 'gone', code: 'QUEUE_ITEM_GONE' }),
    });
    seed([queued('q1', '原始内容', 1)]);
    render(<Panel />);

    fireEvent.click(screen.getByRole('button', { name: '撤回' }));

    await waitFor(() =>
      expect(
        screen.getByText('该排队消息已不可用，可能已送达'),
      ).toBeInTheDocument(),
    );
  });
});
