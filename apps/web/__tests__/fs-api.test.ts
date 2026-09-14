// apps/web/__tests__/fs-api.test.ts
import { describe, it, expect, vi, afterEach } from 'vitest';
import { fetchFsTree, searchFsFiles, fetchFsFile } from '@/lib/fs-api';

afterEach(() => vi.unstubAllGlobals());

function stubOnce(status: number, body: unknown): ReturnType<typeof vi.fn> {
  const fetchMock = vi.fn().mockResolvedValue(
    new Response(JSON.stringify(body), { status }),
  );
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

describe('fs-api', () => {
  it('fetchFsTree encodes params and defaults path to empty', async () => {
    const fetchMock = stubOnce(200, { path: 'src', entries: [{ name: 'a.ts', type: 'file', size: 3 }] });
    const result = await fetchFsTree('p1', 'src/a b');
    expect(result.entries[0]?.name).toBe('a.ts');
    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining('/fs/tree?projectId=p1&path=src%2Fa%20b'),
      expect.objectContaining({ credentials: 'include' }),
    );
  });

  it('fetchFsTree throws the server error message on failure', async () => {
    stubOnce(404, { error: 'Unknown project: p1' });
    await expect(fetchFsTree('p1')).rejects.toThrow('Unknown project: p1');
  });

  it('searchFsFiles returns typed matches; fetchFsFile returns the payload', async () => {
    stubOnce(200, { matches: [{ path: 'README.md', type: 'file' }, { path: 'src', type: 'dir' }] });
    expect(await searchFsFiles('p1', 'read')).toEqual({
      matches: [{ path: 'README.md', type: 'file' }, { path: 'src', type: 'dir' }],
    });

    stubOnce(200, { kind: 'text', content: 'hi', truncated: false, size: 2 });
    expect(await fetchFsFile('p1', 'README.md')).toMatchObject({ kind: 'text' });
  });

  it('fetchFsFile surfaces HTTP status when the body is not an error shape', async () => {
    stubOnce(500, 'oops');
    await expect(fetchFsFile('p1', 'x')).rejects.toThrow('500');
  });
});
