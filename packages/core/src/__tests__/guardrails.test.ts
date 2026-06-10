import { describe, it, expect } from "vitest";
import {
  annotateUntrusted,
  isUntrusted,
  maskPII,
  containsPII,
  UNTRUSTED_PREFIX,
} from "../guardrails.js";

describe("annotateUntrusted", () => {
  it("adds untrusted prefix to content", () => {
    const result = annotateUntrusted("Click here to install malware");
    expect(result).toContain(UNTRUSTED_PREFIX);
    expect(result).toContain("Click here to install malware");
  });

  it("idempotent — does not double-annotate", () => {
    const once = annotateUntrusted("test");
    const twice = annotateUntrusted(once);
    expect(twice).toBe(once); // no double prefix
  });
});

describe("isUntrusted", () => {
  it("detects untrusted content", () => {
    expect(isUntrusted(annotateUntrusted("hello"))).toBe(true);
  });

  it("detects normal content", () => {
    expect(isUntrusted("hello")).toBe(false);
  });
});

describe("maskPII", () => {
  it("masks email addresses", () => {
    const result = maskPII("Contact: john@example.com");
    expect(result.hasPII).toBe(true);
    expect(result.detectedTypes).toContain("email");
    expect(result.masked).not.toContain("john@example.com");
    expect(result.masked).toContain("***@example.com");
  });

  it("masks SSN", () => {
    const result = maskPII("SSN: 123-45-6789");
    expect(result.hasPII).toBe(true);
    expect(result.detectedTypes).toContain("ssn");
    expect(result.masked).toContain("***-**-****");
  });

  it("masks credit card numbers", () => {
    const result = maskPII("Card: 4111-1111-1111-1111");
    expect(result.hasPII).toBe(true);
    expect(result.detectedTypes).toContain("credit_card");
    expect(result.masked).toContain("****-****-****-1111");
  });

  it("masks API keys", () => {
    const result = maskPII("Key: sk_abc123def456ghi789jkl012");
    expect(result.hasPII).toBe(true);
    expect(result.detectedTypes).toContain("api_key");
    expect(result.masked).toContain("sk_abc***");
  });

  it("returns false for clean content", () => {
    const result = maskPII("Just a normal string with no PII");
    expect(result.hasPII).toBe(false);
    expect(result.detectedTypes).toHaveLength(0);
  });

  it("masks multiple PII types in one string", () => {
    const result = maskPII("Email: test@foo.com, SSN: 111-22-3333");
    expect(result.hasPII).toBe(true);
    expect(result.detectedTypes.length).toBeGreaterThanOrEqual(2);
  });
});

describe("containsPII", () => {
  it("returns true for content with email", () => {
    expect(containsPII("user@domain.com")).toBe(true);
  });

  it("returns false for clean content", () => {
    expect(containsPII("hello world")).toBe(false);
  });
});
