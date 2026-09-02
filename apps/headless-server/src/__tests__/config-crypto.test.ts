import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { createCipher } from "../config/crypto.js";

let dir: string;

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "volto-crypto-"));
});

afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

describe("createCipher", () => {
  it("round-trips a value", async () => {
    const cipher = createCipher(dir);
    const enc = await cipher.encrypt("sk-secret-value");
    expect(await cipher.decrypt(enc)).toBe("sk-secret-value");
  });

  it("does not leak the plaintext into the ciphertext", async () => {
    const cipher = createCipher(dir);
    const enc = await cipher.encrypt("sk-secret-value");
    expect(enc).not.toContain("sk-secret-value");
  });

  it("produces a different ciphertext each time (random iv)", async () => {
    const cipher = createCipher(dir);
    const a = await cipher.encrypt("same");
    const b = await cipher.encrypt("same");
    expect(a).not.toBe(b);
    expect(await cipher.decrypt(b)).toBe("same");
  });

  it("creates the key file with 0600 permissions", async () => {
    const cipher = createCipher(dir);
    await cipher.encrypt("x");
    const stat = await fs.stat(path.join(dir, "key"));
    expect(stat.mode & 0o777).toBe(0o600);
  });

  it("rejects a tampered ciphertext instead of returning garbage", async () => {
    const cipher = createCipher(dir);
    const enc = await cipher.encrypt("sk-secret-value");
    const bytes = Buffer.from(enc, "base64");
    bytes[bytes.length - 1] = (bytes[bytes.length - 1] ?? 0) ^ 0xff;
    await expect(cipher.decrypt(bytes.toString("base64"))).rejects.toThrow();
  });

  it("masks a key keeping only the tail", () => {
    expect(createCipher(dir).mask("sk-abcdefgh3f2a")).toBe("sk-…3f2a");
  });

  it("masks a short key without exposing it", () => {
    expect(createCipher(dir).mask("abc")).toBe("…");
  });

  // -- F5: a key file of the wrong size is corrupt, not "missing" --

  it("throws instead of silently regenerating a key file of the wrong size", async () => {
    await fs.mkdir(dir, { recursive: true });
    // A 32-byte key is expected; write something else in its place.
    await fs.writeFile(path.join(dir, "key"), Buffer.from("too-short"));

    await expect(createCipher(dir).encrypt("x")).rejects.toThrow();
  });

  it("does not overwrite an existing ciphertext's decryptability when the key file is wrong-sized", async () => {
    // Encrypt with a real key first.
    const original = createCipher(dir);
    const enc = await original.encrypt("sk-secret-value");

    // Corrupt the key file (e.g. a partial write) — must not silently
    // regenerate it, since that would strand `enc` as undecryptable.
    await fs.writeFile(path.join(dir, "key"), Buffer.alloc(16));

    const afterCorruption = createCipher(dir);
    await expect(afterCorruption.decrypt(enc)).rejects.toThrow();

    // The key file itself must be untouched by the failed attempt, so a
    // human fixing it manually (or restoring a backup) still has a chance.
    const stat = await fs.stat(path.join(dir, "key"));
    expect(stat.size).toBe(16);
  });
});
