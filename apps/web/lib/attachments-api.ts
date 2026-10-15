import { SERVER_URL } from './agent-config';

/**
 * Client for the gateway's attachment endpoints (`POST /attachments`).
 * Files (images, text, PDF) are staged server-side first (AttachmentStore
 * returns an id), then that id travels with `POST /messages` — base64 never
 * enters conversation state. Same SERVER_URL + credentials convention as
 * sessions-api.ts.
 */

/**
 * Client-side copy of the gateway's upload whitelist (spec D1:
 * docs/superpowers/specs/2026-10-15-non-image-attachments-design.md).
 * The real boundary is server-side — `POST /attachments` 400s anything
 * outside this table — so this copy only keeps impossible picks from ever
 * reaching the network (spec §9.3: the client filter is UX, not the
 * boundary). It mirrors `classifyUpload` in
 * apps/headless-server/src/attachments/routes.ts: `text/*` by prefix rule,
 * `application/pdf` and `application/json` by exact match. The `image/`
 * prefix stays broader than the server's image enumeration — a mismatch
 * fails closed at the gateway, never open here.
 */
export function isSupportedAttachmentFile(file: File): boolean {
  const type = file.type;
  return (
    type.startsWith('image/') ||
    type.startsWith('text/') ||
    type === 'application/pdf' ||
    type === 'application/json'
  );
}

/**
 * Whether the current model may receive this file (spec D5:
 * docs/superpowers/specs/2026-10-15-non-image-attachments-design.md).
 * Text / PDF / JSON attachments are available to EVERY model — the image
 * capability (the server's `assertImageInput`, mirrored by the composer's
 * `imageBlocked` state) gates image FILES only, never the whole attachment
 * entry. While a model declares no image input, only `image/*` files are
 * filtered out; the whitelist itself is unchanged.
 */
export function isAttachmentAllowedForModel(file: File, imageBlocked: boolean): boolean {
  if (imageBlocked && file.type.startsWith('image/')) return false;
  return isSupportedAttachmentFile(file);
}

/** Metadata the server returns after storing an image. */
export interface UploadedAttachment {
  id: string;
  mimeType: string;
  size: number;
  width?: number;
  height?: number;
}

/**
 * A non-ok `POST /attachments` response. Carries the HTTP status so callers
 * can branch (413 too large vs 400 bad MIME vs 401 unauth) and the server's
 * `{ error }` body when present.
 */
export class AttachmentUploadError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = 'AttachmentUploadError';
    this.status = status;
  }
}

async function readErrorMessage(response: Response, fallback: string): Promise<string> {
  try {
    const body = (await response.json()) as { error?: unknown };
    return typeof body.error === 'string' && body.error.length > 0 ? body.error : fallback;
  } catch {
    return fallback;
  }
}

/**
 * Encode a File as base64 without FileReader.
 *
 * `arrayBuffer()` + chunked `String.fromCharCode` is promise-native (no
 * onload/onerror callback pair to wrap) and works in jsdom, which is what
 * the hook tests run under. Chunking keeps the spread operator off the
 * whole buffer — a multi-MB image would blow the call-stack argument limit
 * in one `fromCharCode(...bytes)`.
 */
async function fileToBase64(file: File): Promise<string> {
  const buffer = await file.arrayBuffer();
  const bytes = new Uint8Array(buffer);
  const CHUNK = 0x8000;
  let binary = '';
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

/**
 * Upload one whitelisted file to the gateway, carrying its filename so the
 * server can store it in the attachment meta (spec D4 — the stored name is
 * the single source of truth for the inline header line and the UI chip).
 * Throws `AttachmentUploadError` on any non-ok response so the
 * pending-attachment hook can keep the failed item visible and offer a
 * retry.
 */
export async function uploadAttachment(
  sessionId: string,
  file: File,
): Promise<UploadedAttachment> {
  const data = await fileToBase64(file);
  const response = await fetch(`${SERVER_URL}/attachments`, {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      sessionId,
      data,
      mimeType: file.type,
      name: file.name,
    }),
  });
  if (!response.ok) {
    const message = await readErrorMessage(
      response,
      `Failed to upload attachment: HTTP ${response.status}`,
    );
    throw new AttachmentUploadError(response.status, message);
  }
  return (await response.json()) as UploadedAttachment;
}
