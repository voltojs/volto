/**
 * Client for the headless-server's durable transcript endpoints. Stubs
 * fetch rather than talking to a real gateway, same convention as
 * config-store.test.ts.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { fetchServerSessions, fetchServerSessionDetail } from '../lib/sessions-api.js';

function stubFetch(handler: (path: string) => { status: number; body: unknown }): void {
  vi.stubGlobal('fetch', async (input: string | URL) => {
    const { status, body } = handler(new URL(String(input)).pathname);
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

describe('fetchServerSessions', () => {
  it('returns the parsed session summary list', async () => {
    const summaries = [
      {
        id: 's1',
        projectId: 'p1',
        providerId: 'v1',
        modelId: 'm1',
        permissionMode: 'plan',
        messageCount: 2,
        createdAt: 1,
        updatedAt: 2,
      },
    ];
    stubFetch(() => ({ status: 200, body: summaries }));

    await expect(fetchServerSessions()).resolves.toEqual(summaries);
  });

  it('throws when the server responds with an error status', async () => {
    stubFetch(() => ({ status: 500, body: { error: 'boom' } }));

    await expect(fetchServerSessions()).rejects.toThrow('HTTP 500');
  });
});

describe('fetchServerSessionDetail', () => {
  it('returns the parsed session detail', async () => {
    const detail = {
      id: 's1',
      projectId: 'p1',
      providerId: 'v1',
      modelId: 'm1',
      permissionMode: 'plan',
      messages: [{ id: 's1-0', role: 'user', content: 'hi', timestamp: 1 }],
      createdAt: 1,
      updatedAt: 2,
    };
    stubFetch(() => ({ status: 200, body: detail }));

    await expect(fetchServerSessionDetail('s1')).resolves.toEqual(detail);
  });

  it('returns null for an unknown session (404)', async () => {
    stubFetch(() => ({ status: 404, body: { error: 'not found' } }));

    await expect(fetchServerSessionDetail('ghost')).resolves.toBeNull();
  });

  it('throws for a non-404 error status', async () => {
    stubFetch(() => ({ status: 500, body: { error: 'boom' } }));

    await expect(fetchServerSessionDetail('s1')).rejects.toThrow('HTTP 500');
  });
});
