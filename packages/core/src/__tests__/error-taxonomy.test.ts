import { describe, it, expect } from "vitest";
import { classifyError } from "../error-taxonomy.js";

describe("classifyError", () => {
  describe("transient errors", () => {
    it("classifies ECONNRESET as transient", () => {
      const result = classifyError(new Error("read ECONNRESET"));
      expect(result.kind).toBe("transient");
      expect(result.retriable).toBe(true);
    });

    it("classifies ECONNREFUSED as transient", () => {
      const result = classifyError(new Error("connect ECONNREFUSED 127.0.0.1:3000"));
      expect(result.kind).toBe("transient");
      expect(result.retriable).toBe(true);
    });

    it("classifies ETIMEDOUT as transient", () => {
      const result = classifyError(new Error("connect ETIMEDOUT"));
      expect(result.kind).toBe("transient");
    });

    it("classifies socket hang up as transient", () => {
      const result = classifyError(new Error("socket hang up"));
      expect(result.kind).toBe("transient");
    });

    it("classifies network timeout as transient", () => {
      const result = classifyError(new Error("network timeout"));
      expect(result.kind).toBe("transient");
    });
  });

  describe("rate_limited errors", () => {
    it("classifies 429 as rate_limited", () => {
      const result = classifyError(new Error("HTTP 429 Too Many Requests"));
      expect(result.kind).toBe("rate_limited");
      expect(result.retriable).toBe(true);
    });

    it("classifies rate limit messages", () => {
      const result = classifyError(new Error("Rate limit exceeded"));
      expect(result.kind).toBe("rate_limited");
    });
  });

  describe("forbidden errors", () => {
    it("classifies 401 as forbidden", () => {
      const result = classifyError(new Error("HTTP 401 Unauthorized"));
      expect(result.kind).toBe("forbidden");
      expect(result.retriable).toBe(false);
    });

    it("classifies 403 as forbidden", () => {
      const result = classifyError(new Error("HTTP 403 Forbidden"));
      expect(result.kind).toBe("forbidden");
    });

    it("classifies invalid API key as forbidden", () => {
      const result = classifyError(new Error("invalid_api_key"));
      expect(result.kind).toBe("forbidden");
    });
  });

  describe("permanent errors", () => {
    it("classifies unknown errors as permanent", () => {
      const result = classifyError(new Error("some random error"));
      expect(result.kind).toBe("permanent");
      expect(result.retriable).toBe(false);
    });

    it("classifies string errors as permanent", () => {
      const result = classifyError("generic failure");
      expect(result.kind).toBe("permanent");
      expect(result.retriable).toBe(false);
    });

    it("classifies non-Error objects as permanent", () => {
      const result = classifyError({ code: "UNKNOWN" });
      expect(result.kind).toBe("permanent");
      expect(result.retriable).toBe(false);
    });
  });

  describe("determinism", () => {
    it("same error always classifies the same way", () => {
      const err = new Error("ECONNRESET");
      const r1 = classifyError(err);
      const r2 = classifyError(err);
      expect(r1).toEqual(r2);
    });
  });
});
