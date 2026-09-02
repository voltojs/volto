/**
 * apiKey encryption for the on-disk provider configuration.
 *
 * Scope of protection: this keeps the API keys out of plaintext when the
 * config file is accidentally committed, shared, or synced to a cloud
 * backup. It is NOT key custody — any process on this machine that can read
 * `~/.volto/key` can decrypt the values. Do not describe it as more than that.
 */

import * as crypto from "node:crypto";
import * as fs from "node:fs/promises";
import { ensureConfigDir, getConfigDir, getConfigPath } from "./paths.js";

const ALGORITHM = "aes-256-gcm";
const IV_BYTES = 12;
const TAG_BYTES = 16;
const KEY_BYTES = 32;

export function createCipher(dir: string = getConfigDir()) {
  let cached: Buffer | null = null;

  /** Read the key file, generating it on first use. */
  async function loadKey(): Promise<Buffer> {
    if (cached) return cached;

    const keyPath = getConfigPath("key", dir);
    try {
      const existing = await fs.readFile(keyPath);
      if (existing.length === KEY_BYTES) {
        cached = existing;
        return cached;
      }
    } catch {
      // Missing key file — fall through and generate one.
    }

    await ensureConfigDir(dir);
    const generated = crypto.randomBytes(KEY_BYTES);
    await fs.writeFile(keyPath, generated, { mode: 0o600 });
    // writeFile only applies the mode when creating the file; chmod covers
    // the case where a file already existed with looser permissions.
    await fs.chmod(keyPath, 0o600);
    cached = generated;
    return cached;
  }

  return {
    /** Encrypt to base64(iv ‖ authTag ‖ ciphertext). */
    async encrypt(plain: string): Promise<string> {
      const key = await loadKey();
      const iv = crypto.randomBytes(IV_BYTES);
      const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
      const ciphertext = Buffer.concat([
        cipher.update(plain, "utf-8"),
        cipher.final(),
      ]);
      return Buffer.concat([iv, cipher.getAuthTag(), ciphertext]).toString("base64");
    },

    /** Reverse of `encrypt`. Throws when the payload was tampered with. */
    async decrypt(enc: string): Promise<string> {
      const key = await loadKey();
      const raw = Buffer.from(enc, "base64");
      const iv = raw.subarray(0, IV_BYTES);
      const tag = raw.subarray(IV_BYTES, IV_BYTES + TAG_BYTES);
      const ciphertext = raw.subarray(IV_BYTES + TAG_BYTES);

      const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
      decipher.setAuthTag(tag);
      return Buffer.concat([
        decipher.update(ciphertext),
        decipher.final(),
      ]).toString("utf-8");
    },

    /** Render a key for display: only the last 4 characters survive. */
    mask(plain: string): string {
      if (plain.length <= 8) return "…";
      return `${plain.slice(0, 3)}…${plain.slice(-4)}`;
    },
  };
}
