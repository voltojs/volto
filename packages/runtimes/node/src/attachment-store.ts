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

export function createNodeAttachmentStore(opts: NodeAttachmentStoreOptions): AttachmentStore {
  const root = opts.rootDir ?? path.join(os.homedir(), ".volto", "attachments");
  const dirFor = (sessionId: string) => path.join(root, sessionId);

  return {
    async put(data: string, mimeType: string): Promise<StoredAttachment> {
      const dir = dirFor(opts.sessionId);
      await fs.mkdir(dir, { recursive: true });
      const bytes = Buffer.from(data, "base64");
      const id = crypto.randomUUID();
      const dims = readImageDimensions(bytes);
      const meta: StoredAttachment = {
        id,
        mimeType,
        size: bytes.byteLength,
        ...(dims ?? {}),
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
        return { data: bytes.toString("base64"), mimeType: meta.mimeType };
      } catch {
        return undefined;
      }
    },

    async deleteBySession(sessionId: string) {
      // Same separator rejection as get(): a sessionId is a single path
      // segment under root. Anything else would rm outside the store.
      if (isPathEscape(sessionId)) return;
      await fs.rm(dirFor(sessionId), { recursive: true, force: true });
    },
  };
}
