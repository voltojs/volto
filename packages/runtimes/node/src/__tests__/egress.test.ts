import { describe, it, expect } from "vitest";
import { wrapNetworkWithEgress } from "../egress.js";
import type { Network } from "@agent-core/core";

/** Stub Network that always succeeds */
const stubNetwork: Network = {
  async fetch(req) {
    return {
      status: 200,
      headers: { "content-type": "text/plain" },
      body: `ok from ${req.url}`,
    };
  },
};

describe("wrapNetworkWithEgress", () => {
  describe("allowlist mode", () => {
    it("allows requests to hosts in the allowlist", async () => {
      const network = wrapNetworkWithEgress(stubNetwork, {
        allowHosts: ["api.example.com"],
      });

      const resp = await network.fetch({ url: "https://api.example.com/data" });
      expect(resp.status).toBe(200);
    });

    it("denies requests to hosts not in the allowlist", async () => {
      const network = wrapNetworkWithEgress(stubNetwork, {
        allowHosts: ["api.example.com"],
      });

      const resp = await network.fetch({ url: "https://evil.com/steal" });
      expect(resp.status).toBe(403);
      expect(resp.body).toContain("egress_denied");
      expect(resp.body).toContain("evil.com");
    });

    it("allows localhost when in allowlist", async () => {
      const network = wrapNetworkWithEgress(stubNetwork, {
        allowHosts: ["localhost"],
      });

      const resp = await network.fetch({ url: "http://localhost:3000/api" });
      expect(resp.status).toBe(200);
    });
  });

  describe("denylist mode", () => {
    it("denies requests to hosts in the denylist", async () => {
      const network = wrapNetworkWithEgress(stubNetwork, {
        denyHosts: ["evil.com"],
      });

      const resp = await network.fetch({ url: "https://evil.com/steal" });
      expect(resp.status).toBe(403);
    });

    it("allows other hosts", async () => {
      const network = wrapNetworkWithEgress(stubNetwork, {
        denyHosts: ["evil.com"],
      });

      const resp = await network.fetch({ url: "https://api.example.com/data" });
      expect(resp.status).toBe(200);
    });
  });

  describe("combined allowlist + denylist", () => {
    it("denylist takes precedence over allowlist", async () => {
      const network = wrapNetworkWithEgress(stubNetwork, {
        allowHosts: ["api.example.com", "evil.com"],
        denyHosts: ["evil.com"],
      });

      const resp1 = await network.fetch({ url: "https://api.example.com/data" });
      expect(resp1.status).toBe(200);

      const resp2 = await network.fetch({ url: "https://evil.com/steal" });
      expect(resp2.status).toBe(403); // denylist wins
    });
  });

  describe("no policy → allow all", () => {
    it("allows all requests when no policy is set", async () => {
      const network = wrapNetworkWithEgress(stubNetwork, {});
      const resp = await network.fetch({ url: "https://anything.com" });
      expect(resp.status).toBe(200);
    });
  });

  describe("error format", () => {
    it("returns structured error JSON (not throwing)", async () => {
      const network = wrapNetworkWithEgress(stubNetwork, {
        allowHosts: ["safe.com"],
      });

      const resp = await network.fetch({ url: "https://malicious.com/data" });
      expect(resp.status).toBe(403);
      const body = JSON.parse(resp.body);
      expect(body.error).toBe("egress_denied");
      expect(body.message).toContain("malicious.com");
    });
  });
});
