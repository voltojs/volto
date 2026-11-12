/**
 * Manual context-compaction entry: `POST /sessions/:id/compact` client,
 * toast-facing runner, and the ChatHeader button. Contract mirrors Task 5
 * (gateway): branch on `compacted === false` vs `replacedCount`;
 * 409 = busy; conversation content must not change as a result of compact
 * itself (the runner has no message-feed callbacks by design).
 */

import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import {
  compactSession,
  CompactSessionError,
} from '../lib/sessions-api.js';
import { runSessionCompact } from '../lib/session-compact.js';
import { ChatHeader } from '@/components/chat/ChatHeader';

function stubFetch(
  handler: (path: string, init?: RequestInit) => { status: number; body: unknown },
): void {
  vi.stubGlobal('fetch', async (input: string | URL, init?: RequestInit) => {
    const { status, body } = handler(
      new URL(String(input), 'http://localhost').pathname,
      init,
    );
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => body,
    } as Response;
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('compactSession', () => {
  it('POSTs an empty JSON body with credentials to the compact route', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ ok: true, compacted: false }),
    });
    vi.stubGlobal('fetch', fetchMock);

    await compactSession('s1');

    const [url, init] = fetchMock.mock.calls[0]!;
    expect(String(url)).toMatch(/\/sessions\/s1\/compact$/);
    expect((init as RequestInit).method).toBe('POST');
    expect((init as RequestInit).credentials).toBe('include');
    expect(JSON.parse((init as RequestInit).body as string)).toEqual({});
  });

  it('returns compacted:true with replacedCount and tokensFreedEstimate', async () => {
    stubFetch(() => ({
      status: 200,
      body: { replacedCount: 3, tokensFreedEstimate: 1200 },
    }));

    await expect(compactSession('s1')).resolves.toEqual({
      compacted: true,
      replacedCount: 3,
      tokensFreedEstimate: 1200,
    });
  });

  it('returns compacted:false for the nothing-to-do 200 shape', async () => {
    stubFetch(() => ({
      status: 200,
      body: { ok: true, compacted: false },
    }));

    await expect(compactSession('s1')).resolves.toEqual({ compacted: false });
  });

  it('throws a busy-kind error on 409', async () => {
    stubFetch(() => ({ status: 409, body: { error: 'compaction busy' } }));

    const err: unknown = await compactSession('s1').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CompactSessionError);
    expect((err as CompactSessionError).kind).toBe('busy');
    expect((err as CompactSessionError).status).toBe(409);
  });

  it('throws a notFound-kind error on 404', async () => {
    stubFetch(() => ({ status: 404, body: { error: 'Unknown session: s1' } }));

    const err: unknown = await compactSession('s1').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CompactSessionError);
    expect((err as CompactSessionError).kind).toBe('notFound');
  });

  it('throws a network-kind error on other failures', async () => {
    stubFetch(() => ({ status: 500, body: { error: 'boom' } }));

    const err: unknown = await compactSession('s1').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CompactSessionError);
    expect((err as CompactSessionError).kind).toBe('network');
  });
});

describe('runSessionCompact', () => {
  it('reports how many messages were replaced on a real compact', async () => {
    const success = vi.fn();
    const error = vi.fn();
    await runSessionCompact({
      sessionId: 's1',
      compact: async () => ({
        compacted: true,
        replacedCount: 4,
        tokensFreedEstimate: 900,
      }),
      notify: { success, error },
    });

    expect(success).toHaveBeenCalledTimes(1);
    expect(success.mock.calls[0]![0]).toBe('compact.done');
    expect(error).not.toHaveBeenCalled();
  });

  it('reports nothing-to-compact without treating it as a failure', async () => {
    const success = vi.fn();
    const error = vi.fn();
    await runSessionCompact({
      sessionId: 's1',
      compact: async () => ({ compacted: false }),
      notify: { success, error },
    });

    expect(success).toHaveBeenCalledTimes(1);
    expect(error).not.toHaveBeenCalled();
  });

  it('surfaces a busy toast on 409 (retry later)', async () => {
    const success = vi.fn();
    const error = vi.fn();
    await runSessionCompact({
      sessionId: 's1',
      compact: async () => {
        throw new CompactSessionError(409, 'busy', 'compaction busy');
      },
      notify: { success, error },
    });

    expect(error).toHaveBeenCalledTimes(1);
    expect(error.mock.calls[0]![0]).toBe('compact.busy');
    expect(success).not.toHaveBeenCalled();
  });

  it('surfaces unknown-session and network failures as error toasts', async () => {
    const error = vi.fn();
    await runSessionCompact({
      sessionId: 'gone',
      compact: async () => {
        throw new CompactSessionError(404, 'notFound', 'Unknown session');
      },
      notify: { success: vi.fn(), error },
    });
    await runSessionCompact({
      sessionId: 's1',
      compact: async () => {
        throw new CompactSessionError(500, 'network', 'HTTP 500');
      },
      notify: { success: vi.fn(), error },
    });

    expect(error).toHaveBeenCalledTimes(2);
  });
});

describe('ChatHeader 压缩上下文按钮', () => {
  it('renders and fires onCompact from the actions menu', () => {
    const onCompact = vi.fn();
    render(
      <ChatHeader
        title="会话"
        compactAction={{ disabled: false, onCompact }}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: '更多操作' }));
    fireEvent.click(screen.getByText('压缩上下文（摘要旧消息，释放 token）'));
    expect(onCompact).toHaveBeenCalledTimes(1);
  });

  it('is disabled while the session is generating', () => {
    const onCompact = vi.fn();
    render(
      <ChatHeader
        title="会话"
        compactAction={{ disabled: true, onCompact }}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: '更多操作' }));
    fireEvent.click(screen.getByText('压缩上下文（摘要旧消息，释放 token）'));
    expect(onCompact).not.toHaveBeenCalled();
  });

  it('renders no compact button without compactAction props', () => {
    render(<ChatHeader title="欢迎" />);
    expect(screen.queryByRole('button', { name: '压缩上下文' })).toBeNull();
  });
});
