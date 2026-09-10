/**
 * Turn-config request-body tests. Stubs fetch rather than talking to a real
 * gateway, same convention as config-store.test.ts.
 */

import { describe, it, expect, afterEach, vi } from 'vitest';
import {
  postMessage,
  postApproval,
  interruptTurn,
  createGatewaySSEClient,
} from '../lib/agent-config.js';

afterEach(() => {
  vi.unstubAllGlobals();
});

/** Capture the init object handed to a single stubbed fetch call. */
function stubFetchCaptureInit(response: Partial<Response> = { ok: true }) {
  let sentInit: RequestInit | undefined;
  vi.stubGlobal(
    'fetch',
    async (_input: string | URL, init?: RequestInit) => {
      sentInit = init;
      return {
        ok: true,
        json: async () => ({}),
        ...response,
      } as Response;
    },
  );
  return {
    get init() {
      return sentInit;
    },
  };
}

describe('postMessage', () => {
  it('carries reasoningEffort through to the request body', async () => {
    let sentBody: Record<string, unknown> | undefined;
    vi.stubGlobal('fetch', async (_input: string | URL, init?: RequestInit) => {
      sentBody = JSON.parse(init!.body as string);
      return { ok: true, json: async () => ({}) } as Response;
    });

    await postMessage('s1', 'hi', {
      providerId: 'v1',
      modelId: 'm1',
      reasoningEffort: 'eff-high',
    });

    expect(sentBody?.reasoningEffort).toBe('eff-high');
  });

  it('omits reasoningEffort from the request body when unset', async () => {
    let sentBody: Record<string, unknown> | undefined;
    vi.stubGlobal('fetch', async (_input: string | URL, init?: RequestInit) => {
      sentBody = JSON.parse(init!.body as string);
      return { ok: true, json: async () => ({}) } as Response;
    });

    await postMessage('s1', 'hi', { providerId: 'v1', modelId: 'm1' });

    expect(sentBody).not.toHaveProperty('reasoningEffort');
  });

  it('sends credentials so the cookie reaches the gateway', async () => {
    const capture = stubFetchCaptureInit();

    await postMessage('s1', 'hi');

    expect(capture.init?.credentials).toBe('include');
  });
});

describe('postApproval', () => {
  it('carries the per-connection token through to the request body', async () => {
    let sentBody: Record<string, unknown> | undefined;
    vi.stubGlobal('fetch', async (_input: string | URL, init?: RequestInit) => {
      sentBody = JSON.parse(init!.body as string);
      return { ok: true, json: async () => ({}) } as Response;
    });

    await postApproval('s1', 'call-1', 'allow', 'tok-abc');

    expect(sentBody?.token).toBe('tok-abc');
  });

  it('omits the token from the request body when null (never sends the literal "null")', async () => {
    let sentBody: Record<string, unknown> | undefined;
    vi.stubGlobal('fetch', async (_input: string | URL, init?: RequestInit) => {
      sentBody = JSON.parse(init!.body as string);
      return { ok: true, json: async () => ({}) } as Response;
    });

    await postApproval('s1', 'call-1', 'allow', null);

    expect(sentBody).not.toHaveProperty('token');
  });

  it('sends credentials so the cookie reaches the gateway', async () => {
    const capture = stubFetchCaptureInit();

    await postApproval('s1', 'call-1', 'allow', 'tok-abc');

    expect(capture.init?.credentials).toBe('include');
  });
});

describe('interruptTurn', () => {
  it('sends credentials so the cookie reaches the gateway', async () => {
    const capture = stubFetchCaptureInit();

    await interruptTurn('s1');

    expect(capture.init?.credentials).toBe('include');
  });
});

describe('createGatewaySSEClient', () => {
  it('opens the EventSource with withCredentials so the cookie rides the stream', () => {
    const constructed: Array<{ url: string; init?: EventSourceInit }> = [];
    class FakeEventSource {
      url: string;
      withCredentials: boolean;
      onopen: (() => void) | null = null;
      onerror: (() => void) | null = null;
      onmessage: (() => void) | null = null;
      readyState = 0;
      constructor(url: string, init?: EventSourceInit) {
        this.url = url;
        this.withCredentials = init?.withCredentials ?? false;
        constructed.push({ url, init });
      }
      addEventListener() {}
      removeEventListener() {}
      close() {}
    }
    vi.stubGlobal('EventSource', FakeEventSource);

    const client = createGatewaySSEClient('/gateway/events?sessionId=s1');
    client.connect();
    client.destroy();

    expect(constructed).toHaveLength(1);
    expect(constructed[0]?.init?.withCredentials).toBe(true);
  });
});
