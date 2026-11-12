/**
 * Client for the headless-server's durable transcript endpoints. Stubs
 * fetch rather than talking to a real gateway, same convention as
 * config-store.test.ts.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { GATEWAY_URL_KEY, resetGatewayBaseForTest } from '../lib/gateway-base.js';
import {
  fetchServerSessions,
  fetchServerSessionDetail,
  fetchServerTrajectory,
  fetchSessionEvents,
  renameServerSession,
  deleteServerSession,
  TrajectoryUnavailableError,
  SessionDetailUnavailableError,
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

// A fixed absolute base lets the stub compare real request URLs; the resolver
// itself is covered by gateway-base.test.ts.
beforeEach(() => {
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => (key === GATEWAY_URL_KEY ? 'http://gw.test' : null),
  });
  resetGatewayBaseForTest();
});

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
        permissionMode: 'ask',
        messageCount: 2,
        title: '',
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
      permissionMode: 'ask',
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

  it('throws with the server body error text (not just the HTTP status) for a non-404 error status', async () => {
    stubFetch(() => ({ status: 500, body: { error: 'boom' } }));

    await expect(fetchServerSessionDetail('s1')).rejects.toThrow('boom');
  });

  it('falls back to a generic message when the error body is unreadable', async () => {
    vi.stubGlobal('fetch', async () => ({
      ok: false,
      status: 500,
      json: async () => {
        throw new Error('not json');
      },
    }));

    await expect(fetchServerSessionDetail('s1')).rejects.toThrow('HTTP 500');
  });

  // The 410 branch is the one the reviewer flagged: ChatPanel must be able to
  // tell "legacy transcript, retry is pointless" apart from "transient
  // failure, retry might work" — that discrimination has to survive the
  // fetch path itself, not just the error class's constructor.
  it('rejects with a legacy-kind SessionDetailUnavailableError and the server body text for HTTP 410', async () => {
    stubFetch(() => ({
      status: 410,
      body: { error: 'This session was written by an older version and cannot be read by this build.' },
    }));

    const err: unknown = await fetchServerSessionDetail('s1').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SessionDetailUnavailableError);
    expect((err as SessionDetailUnavailableError).kind).toBe('legacy');
    expect((err as Error).message).toBe(
      'This session was written by an older version and cannot be read by this build.',
    );
  });

  it('rejects with a network-kind SessionDetailUnavailableError for HTTP 500', async () => {
    stubFetch(() => ({ status: 500, body: { error: 'boom' } }));

    const err: unknown = await fetchServerSessionDetail('s1').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SessionDetailUnavailableError);
    expect((err as SessionDetailUnavailableError).kind).toBe('network');
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

describe('fetchSessionEvents', () => {
  const body = {
    sessionId: 's-sub-0',
    events: [
      { time: 1, type: 'user_message', data: { content: 'go' }, turn: 1 },
    ],
  };

  it('GETs the raw events endpoint and returns the parsed body', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => body });
    vi.stubGlobal('fetch', fetchMock);

    await expect(fetchSessionEvents('s-sub-0')).resolves.toEqual(body);
    const [url] = fetchMock.mock.calls[0]!;
    expect(String(url)).toMatch(/\/sessions\/s-sub-0\/events$/);
  });

  it('encodes the session id into the path', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => body });
    vi.stubGlobal('fetch', fetchMock);

    await fetchSessionEvents('a/b');
    expect(String(fetchMock.mock.calls[0]![0])).toMatch(/\/sessions\/a%2Fb\/events$/);
  });

  // Unknown ids answer 200 + empty per the server contract, so there is no
  // 404 branch — the 410 branch is the one that matters: the pane must be
  // able to tell "legacy transcript, retry is pointless" from a transient
  // fault, same as the detail/trajectory endpoints.
  it('rejects with a legacy-kind TrajectoryUnavailableError for HTTP 410', async () => {
    stubFetch(() => ({ status: 410, body: { error: 'legacy store' } }));

    const err: unknown = await fetchSessionEvents('s1').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(TrajectoryUnavailableError);
    expect((err as TrajectoryUnavailableError).kind).toBe('legacy');
    expect((err as Error).message).toBe('legacy store');
  });

  it('rejects with a network-kind TrajectoryUnavailableError for HTTP 500', async () => {
    stubFetch(() => ({ status: 500, body: { error: 'boom' } }));

    const err: unknown = await fetchSessionEvents('s1').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(TrajectoryUnavailableError);
    expect((err as TrajectoryUnavailableError).kind).toBe('network');
  });
});

describe('renameServerSession', () => {
  it('PATCHes the title as a user rename by default', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 204 });
    vi.stubGlobal('fetch', fetchMock);

    await renameServerSession('s1', '新标题');

    const [url, init] = fetchMock.mock.calls[0]!;
    expect(String(url)).toMatch(/\/sessions\/s1$/);
    expect((init as RequestInit).method).toBe('PATCH');
    // The server ranks title sources: a client that omits the source would
    // still be treated as a user rename, but saying so makes the intent
    // explicit instead of riding a default.
    expect(JSON.parse((init as RequestInit).body as string)).toEqual({
      title: '新标题',
      source: 'user',
    });
  });

  it('sends an explicit source when asked', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 204 });
    vi.stubGlobal('fetch', fetchMock);

    await renameServerSession('s1', '系统标题', { source: 'model' });

    const init = fetchMock.mock.calls[0]![1] as RequestInit;
    expect(JSON.parse(init.body as string)).toEqual({ title: '系统标题', source: 'model' });
  });

  it('throws on a non-ok response', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 400 }));
    await expect(renameServerSession('s1', '')).rejects.toThrow();
  });
});

describe('deleteServerSession', () => {
  it('DELETEs and tolerates a 404 as already-gone', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: false, status: 404 });
    vi.stubGlobal('fetch', fetchMock);
    await expect(deleteServerSession('s1')).resolves.toBeUndefined();
    expect((fetchMock.mock.calls[0]![1] as RequestInit).method).toBe('DELETE');
  });

  it('throws on other failures', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 500 }));
    await expect(deleteServerSession('s1')).rejects.toThrow();
  });
});
