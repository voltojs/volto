/**
 * SSE client singleton tests.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock @volto/sdk/sse before importing the module under test
vi.mock('@volto/sdk/sse', () => {
  const destroy = vi.fn();
  const mockClient = {
    connect: vi.fn(),
    disconnect: vi.fn(),
    on: vi.fn(),
    onStateChange: vi.fn(),
    destroy,
    getState: vi.fn(),
    getLastEventId: vi.fn(),
    setEventSourceFactory: vi.fn(),
  };
  return {
    createSSEClient: vi.fn(() => ({ ...mockClient, destroy: vi.fn() })),
  };
});

import { getSSEClient, disconnectSSEClient } from '../lib/sse-client.js';
import { createSSEClient } from '@volto/sdk/sse';

const createSSEClientMock = vi.mocked(createSSEClient);

describe('getSSEClient', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    disconnectSSEClient();
  });

  it('should create a client on first call', () => {
    const client = getSSEClient('http://localhost:3000/sse');
    expect(createSSEClientMock).toHaveBeenCalledTimes(1);
    expect(createSSEClientMock).toHaveBeenCalledWith(
      'http://localhost:3000/sse',
    );
    expect(client).toBeDefined();
  });

  it('should reuse the same client when URL is unchanged', () => {
    const first = getSSEClient('http://localhost:3000/sse');
    const second = getSSEClient('http://localhost:3000/sse');
    expect(createSSEClientMock).toHaveBeenCalledTimes(1);
    expect(first).toBe(second);
  });

  it('should destroy and recreate when URL changes', () => {
    const first = getSSEClient('http://localhost:3000/sse');
    const destroySpy = first.destroy;

    const second = getSSEClient('http://localhost:3001/sse');
    expect(destroySpy).toHaveBeenCalledTimes(1);
    expect(createSSEClientMock).toHaveBeenCalledTimes(2);
    expect(first).not.toBe(second);
  });
});

describe('disconnectSSEClient', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    disconnectSSEClient();
  });

  it('should destroy the client and release it', () => {
    const client = getSSEClient('http://localhost:3000/sse');
    const destroySpy = client.destroy;

    disconnectSSEClient();
    expect(destroySpy).toHaveBeenCalledTimes(1);
  });

  it('should be safe to call multiple times', () => {
    getSSEClient('http://localhost:3000/sse');
    disconnectSSEClient();
    // Second call should not throw
    expect(() => disconnectSSEClient()).not.toThrow();
  });

  it('should allow creating a new client after disconnect', () => {
    const first = getSSEClient('http://localhost:3000/sse');
    disconnectSSEClient();
    createSSEClientMock.mockClear();

    const second = getSSEClient('http://localhost:3000/sse');
    expect(createSSEClientMock).toHaveBeenCalledTimes(1);
    expect(first).not.toBe(second);
  });
});
