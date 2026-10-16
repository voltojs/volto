/**
 * Node Network adapter — implements the Network port using globalThis.fetch.
 */

import type { Network, NetworkRequest, NetworkResponse } from "@volto/core";

export interface NodeNetworkOptions {
  /** Default request timeout in milliseconds (default: 30_000) */
  timeout?: number;
}

/**
 * Render the unified timeout signature (spec D3):
 * `[timeout] ${subject} timed out after ${timeoutMs}ms`
 *
 * This template is byte-identical to tools-common's renderTimeoutSignature —
 * pinned by a cross-package test (category dependency rules forbid importing
 * @volto/tools-common here).
 */
export function renderNetworkTimeoutSignature(subject: string, timeoutMs: number): string {
  return `[timeout] ${subject} timed out after ${timeoutMs}ms`;
}

export function createNodeNetwork(options?: NodeNetworkOptions): Network {
  const defaultTimeout = options?.timeout ?? 30_000;

  return {
    async fetch(req: NetworkRequest): Promise<NetworkResponse> {
      // Merge per-request signal with adapter-level timeout.
      const controller = new AbortController();
      // Distinguish the layer's own timeout-abort from an external abort:
      // only the timer sets this flag before aborting (spec §6 — an external
      // abortSignal abort must keep its AbortError identity, not be relabeled
      // as a timeout).
      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        controller.abort();
      }, defaultTimeout);

      // If the caller provides an abortSignal, forward its abort to our controller.
      const onExternalAbort = (): void => controller.abort();
      if (req.abortSignal) {
        if (req.abortSignal.aborted) {
          controller.abort();
        } else {
          req.abortSignal.addEventListener("abort", onExternalAbort, { once: true });
        }
      }

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
        // The layer's own timeout-abort carries the unified timeout
        // signature (spec D3); an external abortSignal abort keeps the
        // AbortError identity below unchanged (spec §6).
        if (timedOut && !req.abortSignal?.aborted) {
          throw new Error(renderNetworkTimeoutSignature(req.url, defaultTimeout));
        }
        // Preserve AbortError identity so callers can distinguish
        // cancellation from genuine network failures.
        if (error instanceof Error && error.name === "AbortError") {
          throw error;
        }
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(`Network fetch failed: ${message}`);
      } finally {
        clearTimeout(timer);
        if (req.abortSignal) {
          req.abortSignal.removeEventListener("abort", onExternalAbort);
        }
      }
    },
  };
}
