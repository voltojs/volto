import { renderHook, act, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useFileRefs } from '../use-file-refs';
import { useFileRefsStore } from '@/stores/file-refs-store';
import { useChatStore } from '@/stores/chat-store';

const REFS = [
  {
    rowKey: '1:1:a0',
    blockRefs: [[{ start: 0, end: 5, path: 'a.ts', source: 'exact' }]],
  },
] as unknown as ReturnType<typeof JSON.parse>;

function stubFetch(body: unknown): ReturnType<typeof vi.fn> {
  const fn = vi.fn(async () => new Response(JSON.stringify(body), { status: 200 }));
  vi.stubGlobal('fetch', fn);
  return fn;
}

beforeEach(() => {
  useFileRefsStore.setState({ bySession: {} });
  useChatStore.setState({ events: [] });
});

afterEach(() => vi.unstubAllGlobals());

describe('useFileRefs', () => {
  it('fetches refs for the session on mount', async () => {
    const fetchMock = stubFetch({ refs: REFS });
    renderHook(() => useFileRefs('p1', 's1'));
    await waitFor(() =>
      expect(useFileRefsStore.getState().bySession['s1']).toEqual(REFS),
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const url = String(fetchMock.mock.calls[0]?.[0] ?? '');
    expect(url).toContain('/file-refs?projectId=p1&sessionId=s1');
  });

  it('drops a stale response after the session changed', async () => {
    let resolveFirst: ((r: Response) => void) | undefined;
    const fetchMock = vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise<Response>((resolve) => {
            resolveFirst = resolve;
          }),
      )
      .mockImplementation(async () => new Response(JSON.stringify({ refs: [] }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const { rerender } = renderHook(({ sid }: { sid: string }) => useFileRefs('p1', sid), {
      initialProps: { sid: 's1' },
    });
    rerender({ sid: 's2' });
    await waitFor(() => expect(useFileRefsStore.getState().bySession['s2']).toEqual([]));
    // The stale s1 response resolves last and must be dropped.
    resolveFirst?.(new Response(JSON.stringify({ refs: REFS }), { status: 200 }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(fetchMock.mock.settledResults.length).toBe(2));
    expect(useFileRefsStore.getState().bySession['s1']).toBeUndefined();
  });

  it('refetches when a new turn ends', async () => {
    const fetchMock = stubFetch({ refs: REFS });
    renderHook(() => useFileRefs('p1', 's1'));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    act(() => {
      useChatStore.setState({
        events: [
          ...useChatStore.getState().events,
          { time: 1, type: 'turn_end', data: { turn: 1, reason: 'end_turn' } },
        ],
      });
    });
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
  });
});
