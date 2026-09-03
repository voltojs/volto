'use client';

import { useEffect, useRef, useState, useCallback } from 'react';
// Subpath import keeps Node-only SDK dependencies out of the browser bundle.
import { createSSEClient } from '@volto/sdk/sse';
import type { SSEEventType, SSEMessage, ConnectionState } from '@volto/sdk/sse';

type SSEClientInstance = ReturnType<typeof createSSEClient>;

interface UseSSEOptions {
  url: string;
  /** Whether to connect automatically on mount. @default true */
  autoConnect?: boolean;
}

interface UseSSEReturn {
  /** Current SSE connection state. */
  state: ConnectionState;
  /** Open the SSE connection. */
  connect: () => void;
  /** Close the SSE connection. */
  disconnect: () => void;
  /** Subscribe to a typed SSE event. Returns an unsubscribe function. */
  on: <T = unknown>(
    event: SSEEventType | '*',
    handler: (data: T) => void,
  ) => () => void;
  /** The most recently received SSE message (any event type). */
  lastMessage: SSEMessage | null;
}

/**
 * Hook that manages a single SSE connection.
 *
 * Creates an SSE client on mount, optionally auto-connects, and
 * provides typed event subscriptions + connection state.
 */
export function useSSE({
  url,
  autoConnect = true,
}: UseSSEOptions): UseSSEReturn {
  const clientRef = useRef<SSEClientInstance | null>(null);
  const [state, setState] = useState<ConnectionState>('disconnected');
  const [lastMessage, setLastMessage] = useState<SSEMessage | null>(null);

  useEffect(() => {
    const client = createSSEClient(url);
    clientRef.current = client;

    const unsubState = client.onStateChange(setState);

    // Track every message for `lastMessage`
    const unsubAll = client.on('*', (msg) => {
      setLastMessage(msg as SSEMessage);
    });

    if (autoConnect) {
      client.connect();
    }

    return () => {
      unsubState();
      unsubAll();
      client.destroy();
      clientRef.current = null;
    };
  }, [url, autoConnect]);

  const connect = useCallback(() => {
    clientRef.current?.connect();
  }, []);

  const disconnect = useCallback(() => {
    clientRef.current?.disconnect();
  }, []);

  const on = useCallback(
    <T = unknown>(
      event: SSEEventType | '*',
      handler: (data: T) => void,
    ): (() => void) => {
      return clientRef.current?.on<T>(event, handler) ?? (() => {});
    },
    [],
  );

  return {
    state,
    connect,
    disconnect,
    on,
    lastMessage,
  };
}
