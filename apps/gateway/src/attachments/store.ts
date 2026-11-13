/**
 * Per-session AttachmentStore cache.
 *
 * Extracted from the /attachments routes so POST /messages can validate
 * attachment ids against the SAME root and session scoping that upload and
 * download use. A second store root would let an id validate here that the
 * upload route could never have written.
 */

import { createNodeAttachmentStore } from "@voltojs/runtime-node";
import type { AttachmentStore } from "@voltojs/core";

export type StoreFor = (sessionId: string) => AttachmentStore;

/**
 * Create a store factory rooted at `attachmentRoot`. Stores are cheap to
 * create but reusing them avoids repeated mkdir calls for the same session.
 */
export function createAttachmentStoreCache(attachmentRoot: string): StoreFor {
  const stores = new Map<string, AttachmentStore>();
  return (sessionId: string): AttachmentStore => {
    let store = stores.get(sessionId);
    if (!store) {
      store = createNodeAttachmentStore({ rootDir: attachmentRoot, sessionId });
      stores.set(sessionId, store);
    }
    return store;
  };
}
