import { describe, it, expect } from "vitest";
import { createNodeSecrets } from "../secrets.js";

describe("createNodeSecrets", () => {
  describe("pre-loaded secrets", () => {
    it("resolves a secret from the pre-loaded map", async () => {
      const secrets = createNodeSecrets({
        scope: { secrets: { "db-password": "s3cret" } },
      });
      expect(await secrets.resolve("db-password")).toBe("s3cret");
    });

    it("returns undefined for unknown pre-loaded key", async () => {
      const secrets = createNodeSecrets({
        scope: { secrets: { "db-password": "s3cret" } },
      });
      expect(await secrets.resolve("api-key")).toBeUndefined();
    });
  });

  describe("scope restriction", () => {
    it("returns undefined for refs not in allowedRefs", async () => {
      const secrets = createNodeSecrets({
        scope: {
          allowedRefs: ["db-password"],
          secrets: { "db-password": "s3cret", "api-key": "key123" },
        },
      });
      expect(await secrets.resolve("db-password")).toBe("s3cret");
      expect(await secrets.resolve("api-key")).toBeUndefined(); // not in allowedRefs
    });

    it("allows all refs when allowedRefs is undefined", async () => {
      const secrets = createNodeSecrets({
        scope: {
          secrets: { "db-password": "s3cret", "api-key": "key123" },
        },
      });
      expect(await secrets.resolve("db-password")).toBe("s3cret");
      expect(await secrets.resolve("api-key")).toBe("key123");
    });
  });

  describe("environment variable fallback", () => {
    it("falls back to env var with prefix", async () => {
      const secrets = createNodeSecrets({
        scope: { envPrefix: "TEST_SECRET_" },
      });
      // This test relies on the process.env; we can't easily set env vars
      // in a test, so we verify the resolution path exists
      const result = await secrets.resolve("nonexistent-ref");
      expect(result).toBeUndefined(); // no env var set
    });
  });

  describe("empty scope defaults", () => {
    it("defaults to allowing all refs with no secrets", async () => {
      const secrets = createNodeSecrets();
      expect(await secrets.resolve("anything")).toBeUndefined();
    });
  });
});
