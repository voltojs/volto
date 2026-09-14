// apps/web/hooks/__tests__/use-file-mention-items.test.tsx
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, waitFor, act } from '@testing-library/react';
import { useFileMentionItems, clearFileMentionCache } from '../use-file-mention-items';

function stubFetch(routes: Record<string, unknown>) {
  return vi.fn(async (input: string | URL | Request) => {
    const url = typeof input === 'string' ? input : input instanceof Request ? input.url : input.href;
    for (const [match, body] of Object.entries(routes)) {
      if (url.includes(match)) return new Response(JSON.stringify(body), { status: 200 });
    }
    return new Response('{"error":"nf"}', { status: 404 });
  });
}

describe('useFileMentionItems', () => {
  beforeEach(() => clearFileMentionCache());
  afterEach(() => vi.unstubAllGlobals());

  it('空查询 → /fs/tree 根目录', async () => {
    const fetchMock = stubFetch({
      '/fs/tree': { path: '', entries: [{ name: 'src', type: 'dir', size: 0 }, { name: 'README.md', type: 'file', size: 5 }] },
    });
    vi.stubGlobal('fetch', fetchMock);
    const { result } = renderHook(() => useFileMentionItems('p1', ''));
    await waitFor(() => expect(result.current.status).toBe('ready'));
    expect(result.current.entries).toEqual([
      { name: 'src', path: 'src', type: 'dir' },
      { name: 'README.md', path: 'README.md', type: 'file' },
    ]);
  });

  it('含 / 不以 / 结尾 → 目录列表 + basename 前缀过滤（目录缓存命中不再请求）', async () => {
    const fetchMock = stubFetch({
      '/fs/tree': { path: 'src/', entries: [{ name: 'components', type: 'dir', size: 0 }, { name: 'main.ts', type: 'file', size: 1 }] },
    });
    vi.stubGlobal('fetch', fetchMock);
    const { result, rerender } = renderHook(({ q }) => useFileMentionItems('p1', q), { initialProps: { q: 'src/main' } });
    await waitFor(() => expect(result.current.status).toBe('ready'));
    expect(result.current.entries).toEqual([{ name: 'main.ts', path: 'src/main.ts', type: 'file' }]);
    const calls = fetchMock.mock.calls.length;
    rerender({ q: 'src/com' });  // 同目录：走缓存
    await waitFor(() => expect(result.current.entries[0]?.name).toBe('components'));
    expect(fetchMock.mock.calls.length).toBe(calls);
  });

  it('不含 / → /fs/search，300ms 防抖；目录命中保留 type=dir', async () => {
    vi.useFakeTimers();
    try {
      const fetchMock = stubFetch({
        '/fs/search': {
          matches: [
            { path: 'src/store', type: 'dir' },
            { path: 'src/store.ts', type: 'file' },
          ],
        },
      });
      vi.stubGlobal('fetch', fetchMock);
      const { result } = renderHook(() => useFileMentionItems('p1', 'store'));
      await act(async () => { await vi.advanceTimersByTimeAsync(299); });
      expect(fetchMock).not.toHaveBeenCalled();
      await act(async () => { await vi.advanceTimersByTimeAsync(1); });
      // brief 原用 waitFor 等 ready：testing-library 的假计时器检测只认 jest 全局，
      // vitest fake timers 下其轮询 setInterval 永不 tick（且超时会跳过 finally 的
      // useRealTimers，泄漏到后续测试）。act 内 advanceTimersByTimeAsync 已冲刷
      // 微任务链、状态已提交，故直接断言（已裁决，三条断言语义不变）。
      expect(result.current.status).toBe('ready');
      expect(result.current.entries).toEqual([
        { name: 'src/store', path: 'src/store', type: 'dir' },
        { name: 'src/store.ts', path: 'src/store.ts', type: 'file' },
      ]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('search 模式请求失败 → 防抖触发后进入 error（不卡 loading）', async () => {
    vi.useFakeTimers();
    try {
      vi.stubGlobal('fetch', vi.fn(async () => new Response('{"error":"boom"}', { status: 500 })));
      const { result } = renderHook(() => useFileMentionItems('p1', 'store'));
      await act(async () => { await vi.advanceTimersByTimeAsync(299); });
      expect(result.current.status).toBe('loading'); // 防抖未触发，错误尚未发生
      await act(async () => { await vi.advanceTimersByTimeAsync(1); });
      expect(result.current.status).toBe('error'); // 修复点：debounced reject 必须送达 status
    } finally {
      vi.useRealTimers();
    }
  });

  it('projectId 为 null → ready 空列表不发请求', () => {
    const fetchMock = stubFetch({});
    vi.stubGlobal('fetch', fetchMock);
    const { result } = renderHook(() => useFileMentionItems(null, ''));
    expect(result.current.status).toBe('ready');
    expect(result.current.entries).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('错误态 + retry；projectId 变化后重置', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{"error":"boom"}', { status: 500 })));
    const { result, rerender } = renderHook(({ p }: { p: string | null }) => useFileMentionItems(p, ''), { initialProps: { p: 'p1' as string | null } });
    await waitFor(() => expect(result.current.status).toBe('error'));
    vi.stubGlobal('fetch', stubFetch({ '/fs/tree': { path: '', entries: [] } }));
    act(() => result.current.retry());
    await waitFor(() => expect(result.current.status).toBe('ready'));
    rerender({ p: 'p2' });
    await waitFor(() => expect(result.current.status).toBe('ready'));
  });
});
