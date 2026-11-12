/**
 * Who is calling, and over what protocol.
 *
 * Behind a tunnel or reverse proxy every request arrives from loopback, so
 * the socket address says nothing about the real client. The forwarded
 * headers DO say — but only the operator can know whether a proxy is in
 * front of this process, because a directly reachable port makes those
 * headers attacker-controlled. That is the whole point of `--trust-proxy`:
 * `false` (the default) reads the socket, `true` reads the first forwarded
 * hop. Nothing here infers trust from the request itself.
 */

import type { IncomingMessage } from "node:http";

export interface ClientAddressOptions {
  /** Only true when an operator stated that a proxy terminates the connection. */
  trustProxy: boolean;
}

/** First value of a possibly repeated header. */
function header(req: IncomingMessage, name: string): string | undefined {
  const value = req.headers[name];
  if (Array.isArray(value)) return value[0];
  return value;
}

/**
 * First non-empty hop of a comma-separated forwarding header, trimmed.
 * Each proxy appends to the RIGHT, so the left-most entry is the original
 * client — and the only entry a client cannot have appended for someone
 * else beyond the trusted edge.
 */
function firstHop(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  for (const part of value.split(",")) {
    const trimmed = part.trim();
    if (trimmed !== "") return trimmed;
  }
  return undefined;
}

/**
 * The address the rate limiter counts against.
 *
 * `trustProxy: false` always answers with the socket address, so no request
 * header can move another client's accounting. `trustProxy: true` prefers the
 * first `X-Forwarded-For` hop and falls back to the socket address when the
 * header is absent or empty (a direct caller of a proxy-fronted gateway).
 */
export function resolveClientIp(req: IncomingMessage, opts: ClientAddressOptions): string {
  if (opts.trustProxy) {
    const forwarded = firstHop(header(req, "x-forwarded-for"));
    if (forwarded !== undefined) return forwarded;
  }
  const socket = (req.socket as { remoteAddress?: string | undefined } | undefined)?.remoteAddress;
  return socket !== undefined && socket !== "" ? socket : "unknown";
}

/**
 * The protocol the browser actually used: `https:` or `http:`.
 *
 * Direct TLS is the socket's own fact (`encrypted`). Behind a TLS-terminating
 * tunnel the socket is plain HTTP while the browser used https, and
 * `X-Forwarded-Proto` is the only evidence — trusted under the same switch as
 * `X-Forwarded-For`.
 */
export function resolveProtocol(req: IncomingMessage, opts: ClientAddressOptions): "https:" | "http:" {
  const encrypted = (req.socket as { encrypted?: boolean } | undefined)?.encrypted;
  if (encrypted === true) return "https:";
  if (opts.trustProxy) {
    const forwarded = header(req, "x-forwarded-proto")?.split(",")[0]?.trim().toLowerCase();
    if (forwarded === "https") return "https:";
  }
  return "http:";
}