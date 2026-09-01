import { sse } from "@volto/sdk";

type SSEClientInstance = ReturnType<typeof sse.createSSEClient>;

let client: SSEClientInstance | null = null;

/**
 * Get (or lazily create) a singleton SSE client for the given URL.
 * Calling with a different URL than the existing client destroys
 * the previous one and creates a fresh connection.
 */
export function getSSEClient(url: string): SSEClientInstance {
  if (client) {
    client.destroy();
  }
  client = sse.createSSEClient(url);
  return client;
}

/** Disconnect and release the singleton SSE client. */
export function disconnectSSEClient(): void {
  if (client) {
    client.destroy();
    client = null;
  }
}
