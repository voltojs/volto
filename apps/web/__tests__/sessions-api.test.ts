/**
 * Client for the headless-server's durable transcript endpoints. Stubs
 * fetch rather than talking to a real gateway, same convention as
 * config-store.test.ts.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  fetchServerSessions,
  fetchServerSessionDetail,
  fetchServerTrajectory,
  TrajectoryUnavailableError,
} from '../lib/sessions-api.js';

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
    stubFetch(() => ({ status: 200, body: { sessions: summaries, unreadableSessions: 0 } }));

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
      messages: [
        {
          id: 's1-0',
          role: 'user',
          content: 'hi',
          blocks: [{ type: 'text', text: 'hi' }],
          timestamp: 1,
        },
      ],
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

describe('fetchServerTrajectory', () => {
  it('returns the parsed trajectory view', async () => {
    const trajectory = {
      rows: [
        {
          index: 1,
          kind: 'request',
          time: 1,
          step: 1,
          model: 'm1',
          headerHash: 'h1',
        },
      ],
    };
    stubFetch(() => ({ status: 200, body: trajectory }));

    await expect(fetchServerTrajectory('s1')).resolves.toEqual(trajectory);
  });

  it('returns null for an unknown session (404)', async () => {
    stubFetch(() => ({ status: 404, body: { error: 'not found' } }));

    await expect(fetchServerTrajectory('ghost')).resolves.toBeNull();
  });

  it('throws for a non-404 error status', async () => {
    stubFetch(() => ({ status: 500, body: { error: 'boom' } }));

    await expect(fetchServerTrajectory('s1')).rejects.toThrow(
      'Failed to load trajectory s1: HTTP 500',
    );
  });

  // The typed error has to survive the fetch path itself (not just the class
  // constructor): the hook branches on `kind` to pick the user-facing message.
  it('rejects with a legacy-kind TrajectoryUnavailableError for HTTP 410', async () => {
    stubFetch(() => ({ status: 410, body: { error: 'legacy store' } }));

    const err: unknown = await fetchServerTrajectory('s1').catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(TrajectoryUnavailableError);
    expect((err as TrajectoryUnavailableError).kind).toBe('legacy');
  });

  it('rejects with a network-kind TrajectoryUnavailableError for HTTP 500', async () => {
    stubFetch(() => ({ status: 500, body: { error: 'boom' } }));

    const err: unknown = await fetchServerTrajectory('s1').catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(TrajectoryUnavailableError);
    expect((err as TrajectoryUnavailableError).kind).toBe('network');
  });
});
