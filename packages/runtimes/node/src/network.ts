/**
 * Node Network adapter — implements the Network port using globalThis.fetch.
 */

import type { Network, NetworkRequest, NetworkResponse } from "@agent-core/core";

export interface NodeNetworkOptions {
  /** Default request timeout in milliseconds (default: 30_000) */
  timeout?: number;
}

export function createNodeNetwork(options?: NodeNetworkOptions): Network {
  const defaultTimeout = options?.timeout ?? 30_000;

  return {
    async fetch(req: NetworkRequest): Promise<NetworkResponse> {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), defaultTimeout);

      try {
        const response = await globalThis.fetch(req.url, {
          method: req.method ?? "GET",
          headers: req.headers,
          body: req.body,
          signal: controller.signal,
        });

        const body = await response.text();
        const headers: Record<string, string> = {};
        response.headers.forEach((value, key) => {
          headers[key] = value;
        });

        return {
          status: response.status,
          headers,
          body,
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(`Network fetch failed: ${message}`);
      } finally {
        clearTimeout(timer);
      }
    },
  };
}
