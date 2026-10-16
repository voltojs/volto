import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { AttachmentStore, StoredAttachment } from "@volto/core";
import { readImageDimensions } from "./image-dimensions.js";

export interface NodeAttachmentStoreOptions {
  /**
   * Storage root. Defaults to ~/.volto/attachments, which SAFETY.md already
   * denies to sandboxed processes — attachments must stay outside the
   * workspace so the agent cannot read its own store back through
   * read_file / glob / bash.
   */
  rootDir?: string;
  sessionId: string;
}

const SIDECAR = ".json";

/** A storage path segment is a single name; separators or `..` are escapes. */
function isPathEscape(segment: string): boolean {
  return segment.includes("/") || segment.includes("\\") || segment.includes("..");
}

/**
 * A session id must be a single, non-empty path segment under root.
 *
 * The empty string matters as much as a separator does: path.join(root, "")
 * resolves to root itself, so an unguarded deleteBySession("") would
 * recursively remove every session's attachments rather than one session's.
 */
function isValidSegment(segment: string): boolean {
  if (segment.trim() === "") return false;
  if (segment === "." || segment === "..") return false;
  return !segment.includes("/") && !segment.includes("\\") && !segment.includes("..");
}

export function createNodeAttachmentStore(opts: NodeAttachmentStoreOptions): AttachmentStore {
  const root = opts.rootDir ?? path.join(os.homedir(), ".volto", "attachments");
  if (!isValidSegment(opts.sessionId)) {
    throw new Error(
      `Invalid attachment store sessionId: ${JSON.stringify(opts.sessionId)} — must be a non-empty path segment`,
    );
  }
  const dirFor = (sessionId: string) => path.join(root, sessionId);

  return {
    async put(data: string, mimeType: string, putOpts?: { name?: string; id?: string }): Promise<StoredAttachment> {
      const dir = dirFor(opts.sessionId);
      await fs.mkdir(dir, { recursive: true });
      const bytes = Buffer.from(data, "base64");
      // Explicit id (T7/D4): the compaction offload derives a deterministic
      // id so re-running the same input sequence overwrites the same slot
      // instead of minting a fresh uuid. An invalid segment is REJECTED —
      // silently falling back would hide a derivation bug and break the
      // replay guarantee the caller asked for.
      if (putOpts?.id !== undefined) {
        if (!isValidSegment(putOpts.id)) {
          throw new Error(
            `Invalid attachment id: ${JSON.stringify(putOpts.id)} — must be a valid path segment`,
          );
        }
      }
      const id = putOpts?.id ?? crypto.randomUUID();
      const dims = readImageDimensions(bytes);
      const meta: StoredAttachment = {
        id,
        mimeType,
        size: bytes.byteLength,
        ...(dims ?? {}),
        // The name is the client's original filename: model-visible only,
        // stored as a sidecar field, never part of the address (id alone).
        // Absent putOpts.name must leave the key out, not store an empty one.
        ...(putOpts?.name !== undefined ? { name: putOpts.name } : {}),
      };
      await fs.writeFile(path.join(dir, id), bytes);
      await fs.writeFile(path.join(dir, id + SIDECAR), JSON.stringify(meta), "utf8");
      return meta;
    },

    async get(id: string) {
      // Reject separators outright: an id is a uuid, and anything else is an
      // attempt to escape the session directory.
      if (isPathEscape(id)) return undefined;
      const dir = dirFor(opts.sessionId);
      try {
        const [bytes, raw] = await Promise.all([
          fs.readFile(path.join(dir, id)),
          fs.readFile(path.join(dir, id + SIDECAR), "utf8"),
        ]);
        const meta = JSON.parse(raw) as StoredAttachment;
        return { ...meta, data: bytes.toString("base64") };
      } catch {
        return undefined;
      }
    },

    async deleteBySession(sessionId: string) {
      // Reject anything that is not a single non-empty segment: an empty or
      // "." id resolves to root itself, and separators would rm outside the
      // store. A stray delete is a runtime call, so ignore rather than throw.
      if (!isValidSegment(sessionId)) return;
      await fs.rm(dirFor(sessionId), { recursive: true, force: true });
    },
  };
}
