/**
 * Browser Network implementation.
 * Wraps the global fetch API (available in browsers and edge runtimes).
 */

import type { Network, NetworkRequest, NetworkResponse } from "@voltojs/core";

export interface BrowserNetworkOptions {
  /** Default timeout in milliseconds (default: 30000) */
  timeout?: number;
}

export function createBrowserNetwork(opts: BrowserNetworkOptions = {}): Network {
  const timeout = opts.timeout ?? 30_000;

  return {
    async fetch(req: NetworkRequest): Promise<NetworkResponse> {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), timeout);

      // Merge with caller's abort signal
      if (req.abortSignal) {
        req.abortSignal.addEventListener("abort", () => controller.abort());
      }

      try {
        const response = await fetch(req.url, {
          method: req.method ?? "GET",
          headers: req.headers,
          body: req.body,
          signal: controller.signal,
        });

        const headers: Record<string, string> = {};
        response.headers.forEach((value, key) => {
          headers[key] = value;
        });

        return {
          status: response.status,
          headers,
          body: await response.text(),
        };
      } finally {
        clearTimeout(timeoutId);
      }
    },
  };
}
