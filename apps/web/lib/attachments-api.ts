/**
 * Client for the gateway's attachment endpoints (`POST /attachments`).
 * Images are staged server-side first (AttachmentStore returns an id), then
 * that id travels with `POST /messages` — base64 never enters conversation
 * state. Same SERVER_URL + credentials convention as sessions-api.ts.
 */

import { SERVER_URL } from './agent-config';

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
 * Upload one image file to the gateway. Throws `AttachmentUploadError` on
 * any non-ok response so the pending-attachment hook can keep the failed
 * item visible and offer a retry.
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
