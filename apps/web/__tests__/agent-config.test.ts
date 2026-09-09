/**
 * Turn-config request-body tests. Stubs fetch rather than talking to a real
 * gateway, same convention as config-store.test.ts.
 */

import { describe, it, expect, afterEach, vi } from 'vitest';
import { postMessage, postApproval } from '../lib/agent-config.js';

afterEach(() => {
  vi.unstubAllGlobals();
});

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
});
