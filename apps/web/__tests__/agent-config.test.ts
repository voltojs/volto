/**
 * Turn-config request-body tests. Stubs fetch rather than talking to a real
 * gateway, same convention as config-store.test.ts.
 */

import { describe, it, expect, afterEach, vi } from 'vitest';
import { postMessage } from '../lib/agent-config.js';

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
