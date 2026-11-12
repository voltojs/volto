import { describe, expect, it } from "vitest";
import type { IncomingMessage } from "node:http";
import { resolveClientIp, resolveProtocol } from "../client-ip.js";

function reqWith(headers: Record<string, string>, socket: { remoteAddress?: string } = {}): IncomingMessage {
  return { headers, socket } as unknown as IncomingMessage;
}

describe("resolveClientIp", () => {
  it("uses the socket address when the proxy is not trusted", () => {
    const req = reqWith({ "x-forwarded-for": "203.0.113.9" }, { remoteAddress: "127.0.0.1" });
    expect(resolveClientIp(req, { trustProxy: false })).toBe("127.0.0.1");
  });

  it("ignores a forged X-Forwarded-For naming someone else", () => {
    // The attacker's own header must not move the accounting off their socket.
    const req = reqWith({ "x-forwarded-for": "198.51.100.7" }, { remoteAddress: "127.0.0.1" });
    expect(resolveClientIp(req, { trustProxy: false })).toBe("127.0.0.1");
  });

  it("falls back to `unknown` when the socket address is absent and the proxy is untrusted", () => {
    const req = reqWith({ "x-forwarded-for": "203.0.113.9" }, {});
    expect(resolveClientIp(req, { trustProxy: false })).toBe("unknown");
  });

  it("takes the first X-Forwarded-For hop when the proxy is trusted", () => {
    const req = reqWith({ "x-forwarded-for": "203.0.113.9, 70.41.3.18, 150.172.238.178" }, { remoteAddress: "127.0.0.1" });
    expect(resolveClientIp(req, { trustProxy: true })).toBe("203.0.113.9");
  });

  it("trims the hop it picks", () => {
    const req = reqWith({ "x-forwarded-for": "  203.0.113.9  ,  10.0.0.1 " }, { remoteAddress: "127.0.0.1" });
    expect(resolveClientIp(req, { trustProxy: true })).toBe("203.0.113.9");
  });

  it("skips empty leading segments instead of returning an empty string", () => {
    const req = reqWith({ "x-forwarded-for": " , ,203.0.113.9" }, { remoteAddress: "127.0.0.1" });
    expect(resolveClientIp(req, { trustProxy: true })).toBe("203.0.113.9");
  });

  it("falls back to the socket address when the header is missing", () => {
    const req = reqWith({}, { remoteAddress: "::1" });
    expect(resolveClientIp(req, { trustProxy: true })).toBe("::1");
  });

  it("falls back to the socket address when the header carries nothing usable", () => {
    const req = reqWith({ "x-forwarded-for": "   ,  " }, { remoteAddress: "127.0.0.1" });
    expect(resolveClientIp(req, { trustProxy: true })).toBe("127.0.0.1");
  });

  it("reads the first value of a repeated header (Node's string[] form)", () => {
    const req = reqWith({}, { remoteAddress: "127.0.0.1" });
    (req.headers as Record<string, string | string[]>)["x-forwarded-for"] = ["203.0.113.9", "10.0.0.1"];
    expect(resolveClientIp(req, { trustProxy: true })).toBe("203.0.113.9");
  });
});

describe("resolveProtocol", () => {
  it("is plain http on an unencrypted socket", () => {
    expect(resolveProtocol(reqWith({ "x-forwarded-proto": "https" }, { remoteAddress: "127.0.0.1" }), { trustProxy: false })).toBe("http:");
  });

  it("is https on a direct TLS socket", () => {
    const req = reqWith({}, { remoteAddress: "127.0.0.1" }) as unknown as { socket: { encrypted: boolean } };
    req.socket.encrypted = true;
    expect(resolveProtocol(req as unknown as IncomingMessage, { trustProxy: false })).toBe("https:");
  });

  it("honours X-Forwarded-Proto: https only when the proxy is trusted", () => {
    // The tunnel terminates TLS and speaks plain HTTP to the gateway; this
    // header is the only evidence the browser used https.
    const trusted = reqWith({ "x-forwarded-proto": "https" }, { remoteAddress: "127.0.0.1" });
    expect(resolveProtocol(trusted, { trustProxy: true })).toBe("https:");
    expect(resolveProtocol(trusted, { trustProxy: false })).toBe("http:");
  });

  it("takes the first hop of X-Forwarded-Proto and accepts a comma list", () => {
    const req = reqWith({ "x-forwarded-proto": "https, http" }, { remoteAddress: "127.0.0.1" });
    expect(resolveProtocol(req, { trustProxy: true })).toBe("https:");
    const httpOnly = reqWith({ "x-forwarded-proto": "http" }, { remoteAddress: "127.0.0.1" });
    expect(resolveProtocol(httpOnly, { trustProxy: true })).toBe("http:");
  });
});