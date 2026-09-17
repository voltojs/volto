// apps/web/hooks/__tests__/use-attachments.test.tsx
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import { usePendingAttachments } from '../use-attachments';

function pngFile(name = 'a.png') {
  return new File([Uint8Array.from([0x89, 0x50, 0x4e, 0x47])], name, {
    type: 'image/png',
  });
}

let objectUrlSeq = 0;
const revokedUrls: string[] = [];

beforeEach(() => {
  objectUrlSeq = 0;
  revokedUrls.length = 0;
  // jsdom does not implement object URLs. Assign onto the existing URL
  // constructor (do not replace it) so unmount cleanup still sees the stub
  // after afterEach ordering runs.
  Object.assign(URL, {
    createObjectURL: vi.fn(() => `blob:mock-${++objectUrlSeq}`),
    revokeObjectURL: vi.fn((url: string) => {
      revokedUrls.push(url);
    }),
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('usePendingAttachments', () => {
  it('moves an item to ready with a server id after upload', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({ id: 'att-1', mimeType: 'image/png', size: 4 }),
            { status: 201 },
          ),
      ),
    );

    const { result } = renderHook(() => usePendingAttachments('s1'));
    await act(async () => {
      await result.current.add(pngFile());
    });
    await waitFor(() => expect(result.current.items[0]?.status).toBe('ready'));
    expect(result.current.items[0]?.id).toBe('att-1');
    expect(result.current.items[0]?.previewUrl).toBe('blob:mock-1');
  });

  it('marks a failed upload as retryable rather than dropping it', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('boom', { status: 500 })));
    const { result } = renderHook(() => usePendingAttachments('s1'));
    await act(async () => {
      await result.current.add(pngFile());
    });
    await waitFor(() => expect(result.current.items[0]?.status).toBe('failed'));
    // The item stays in the list: silently discarding it would leave the user
    // believing the picture is attached.
    expect(result.current.items).toHaveLength(1);
    expect(result.current.items[0]?.error).toBeTruthy();
  });

  it('retries a failed upload with the same localId', async () => {
    let call = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        call += 1;
        return call === 1
          ? new Response('boom', { status: 500 })
          : new Response(
              JSON.stringify({ id: 'att-2', mimeType: 'image/png', size: 4 }),
              { status: 201 },
            );
      }),
    );

    const { result } = renderHook(() => usePendingAttachments('s1'));
    await act(async () => {
      await result.current.add(pngFile());
    });
    await waitFor(() => expect(result.current.items[0]?.status).toBe('failed'));
    const localId = result.current.items[0]!.localId;
    await act(async () => {
      await result.current.retry(localId);
    });
    await waitFor(() => expect(result.current.items[0]?.status).toBe('ready'));
    expect(result.current.items[0]?.id).toBe('att-2');
    expect(result.current.items[0]?.localId).toBe(localId);
    expect(result.current.items).toHaveLength(1);
  });

  it('removes a single item without disturbing the others', async () => {
    let n = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              id: `att-${++n}`,
              mimeType: 'image/png',
              size: 4,
            }),
            { status: 201 },
          ),
      ),
    );
    const { result } = renderHook(() => usePendingAttachments('s1'));
    await act(async () => {
      await result.current.add(pngFile('a.png'));
    });
    await act(async () => {
      await result.current.add(pngFile('b.png'));
    });
    await waitFor(() => expect(result.current.items).toHaveLength(2));

    const first = result.current.items[0]!.localId;
    const firstUrl = result.current.items[0]!.previewUrl;
    act(() => {
      result.current.remove(first);
    });
    expect(result.current.items).toHaveLength(1);
    expect(result.current.items[0]?.localId).not.toBe(first);
    expect(revokedUrls).toContain(firstUrl);
  });

  it('rejects a non-image file before uploading', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    const { result } = renderHook(() => usePendingAttachments('s1'));
    await act(async () => {
      await result.current.add(new File(['x'], 'a.sh', { type: 'application/x-sh' }));
    });
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(result.current.items).toHaveLength(0);
  });

  it('clear drops every item and revokes their object URLs', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({ id: 'att-c', mimeType: 'image/png', size: 4 }),
            { status: 201 },
          ),
      ),
    );
    const { result } = renderHook(() => usePendingAttachments('s1'));
    await act(async () => {
      await result.current.add(pngFile('a.png'));
    });
    await act(async () => {
      await result.current.add(pngFile('b.png'));
    });
    await waitFor(() => expect(result.current.items).toHaveLength(2));
    const urls = result.current.items.map((i) => i.previewUrl);

    act(() => {
      result.current.clear();
    });
    expect(result.current.items).toHaveLength(0);
    for (const url of urls) {
      expect(revokedUrls).toContain(url);
    }
  });

  it('resets pending items when sessionId changes so a failed pick cannot cross sessions', async () => {
    const fetchSpy = vi.fn(async () => new Response('boom', { status: 500 }));
    vi.stubGlobal('fetch', fetchSpy);

    const { result, rerender } = renderHook(
      ({ sid }: { sid: string }) => usePendingAttachments(sid),
      { initialProps: { sid: 's-a' } },
    );
    await act(async () => {
      await result.current.add(pngFile());
    });
    await waitFor(() => expect(result.current.items[0]?.status).toBe('failed'));
    const staleLocalId = result.current.items[0]!.localId;
    const staleUrl = result.current.items[0]!.previewUrl;
    fetchSpy.mockClear();

    rerender({ sid: 's-b' });
    await waitFor(() => expect(result.current.items).toHaveLength(0));
    expect(revokedUrls).toContain(staleUrl);

    // A leftover localId from session A must not POST A's file under B.
    await act(async () => {
      await result.current.retry(staleLocalId);
    });
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
