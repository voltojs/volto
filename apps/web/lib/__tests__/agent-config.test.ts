import { describe, it, expect, vi, beforeEach } from 'vitest';
import { postApproval } from '../agent-config';

// Mock global fetch
const fetchMock = vi.fn();
vi.stubGlobal('fetch', fetchMock);

beforeEach(() => {
  fetchMock.mockReset();
});

describe('postApproval', () => {
  it('sends remember and returns the receipt', async () => {
    fetchMock.mockResolvedValue(
      new Response(
        JSON.stringify({
          status: 'ok',
          remembered: {
            rule: { toolName: 'bash' },
            outcome: 'saved',
            effectiveFrom: 'next_turn',
          },
        }),
        { status: 200 },
      ),
    );
    const outcome = await postApproval('s1', 'c1', 'allow', 't', undefined, {
      prefixTokens: 2,
    });
    expect(JSON.parse(fetchMock.mock.calls[0]![1].body as string)).toMatchObject({
      remember: { prefixTokens: 2 },
    });
    expect(outcome.remembered?.outcome).toBe('saved');
  });

  it('surfaces a remember failure without failing the approval', async () => {
    fetchMock.mockResolvedValue(
      new Response(
        JSON.stringify({ status: 'ok', rememberError: 'boom' }),
        { status: 200 },
      ),
    );
    const outcome = await postApproval('s1', 'c1', 'allow', 't', undefined, {
      prefixTokens: 2,
    });
    expect(outcome.rememberError).toBe('boom');
  });

  it('omits the remember field entirely when not remembering', async () => {
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ status: 'ok' }), { status: 200 }),
    );
    await postApproval('s1', 'c1', 'allow', 't');
    expect(
      JSON.parse(fetchMock.mock.calls[0]![1].body as string),
    ).not.toHaveProperty('remember');
  });

  it('returns empty object on 409 (stale card)', async () => {
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ error: 'stale' }), { status: 409 }),
    );
    const outcome = await postApproval('s1', 'c1', 'allow', 't');
    expect(outcome).toEqual({});
  });

  it('throws on non-2xx, non-409 errors', async () => {
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ error: 'forbidden' }), { status: 403 }),
    );
    await expect(postApproval('s1', 'c1', 'allow', 't')).rejects.toThrow(
      'forbidden',
    );
  });
});
