// Subpath import keeps Node-only SDK dependencies out of the browser bundle.
import { createSSEClient } from '@volto/sdk/sse';

type SSEClientInstance = ReturnType<typeof createSSEClient>;

let client: SSEClientInstance | null = null;
let currentUrl: string | null = null;

/**
 * Get (or lazily create) a singleton SSE client for the given URL.
 * Reuses the existing client when the URL has not changed.
 * When the URL changes, the previous client is destroyed first.
 */
export function getSSEClient(url: string): SSEClientInstance {
  if (client && currentUrl === url) {
    return client;
  }

  if (client) {
    client.destroy();
  }

  client = createSSEClient(url);
  currentUrl = url;
  return client;
}

/** Disconnect and release the singleton SSE client. */
export function disconnectSSEClient(): void {
  if (client) {
    client.destroy();
    client = null;
    currentUrl = null;
  }
}
