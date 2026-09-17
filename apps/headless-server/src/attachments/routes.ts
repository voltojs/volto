/**
 * Attachment upload/download routes for the web UI.
 *
 * POST /attachments  — store an image, return its metadata
 * GET  /attachments/:id?sessionId= — serve the bytes back
 *
 * The AttachmentStore is session-scoped: a store instance is created (or
 * reused) per request sessionId so one session can never read another
 * session's attachments. Cross-session reads answer 404 rather than 403 —
 * confirming that an id exists somewhere else is itself a leak.
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import { MAX_IMAGE_BASE64 } from "@volto/tools-common";
import type { StoreFor } from "./store.js";

/** Image MIME types accepted on upload. */
const ALLOWED_MIME_TYPES = new Set([
  "image/png",
  "image/jpeg",
  "image/jpg",
  "image/gif",
  "image/webp",
]);

/**
 * Body-size limit for the attachments route. The global MAX_BODY_BYTES (1 MB)
 * is too small for a base64 image payload; this allows up to the shared
 * MAX_IMAGE_BASE64 cap plus JSON overhead.
 */
const ATTACHMENT_BODY_LIMIT = MAX_IMAGE_BASE64 + 64 * 1024;

function readBodyLimited(req: IncomingMessage, limit: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    let rejected = false;
    req.on("data", (chunk: Buffer) => {
      if (rejected) return;
      total += chunk.length;
      if (total > limit) {
        rejected = true;
        reject(new BodyTooLarge());
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (!rejected) resolve(Buffer.concat(chunks).toString("utf-8"));
    });
    req.on("error", (err) => {
      if (!rejected) reject(err);
    });
  });
}

class BodyTooLarge extends Error {
  constructor() {
    super("Request body too large");
    this.name = "BodyTooLarge";
  }
}

export interface AttachmentRouteDeps {
  /**
   * Per-session store factory. Shared with POST /messages so attachment-id
   * validation resolves against the same root and session scoping as
   * upload/download — see attachments/store.ts.
   */
  storeFor: StoreFor;
}

/**
 * Create the route handler for /attachments. Returns a function that
 * attempts to handle the request; returns true if it wrote a response.
 */
export function createAttachmentRoutes(deps: AttachmentRouteDeps) {
  const { storeFor } = deps;

  return async function handle(
    req: IncomingMessage,
    res: ServerResponse,
    url: URL,
    corsHeaders: Record<string, string>,
    jsonResponse: (res: ServerResponse, status: number, body: unknown) => void,
  ): Promise<boolean> {
    // POST /attachments
    if (req.method === "POST" && url.pathname === "/attachments") {
      try {
        const raw = await readBodyLimited(req, ATTACHMENT_BODY_LIMIT);
        const body = JSON.parse(raw) as {
          sessionId?: string;
          data?: string;
          mimeType?: string;
        };

        if (
          typeof body.sessionId !== "string" ||
          body.sessionId === "" ||
          typeof body.data !== "string" ||
          typeof body.mimeType !== "string"
        ) {
          jsonResponse(res, 400, { error: "sessionId, data, and mimeType are required" });
          return true;
        }

        if (!ALLOWED_MIME_TYPES.has(body.mimeType)) {
          jsonResponse(res, 400, { error: `Unsupported mimeType: ${body.mimeType}` });
          return true;
        }

        if (body.data.length > MAX_IMAGE_BASE64) {
          jsonResponse(res, 413, { error: "Image exceeds the maximum allowed size" });
          return true;
        }

        const store = storeFor(body.sessionId);
        const meta = await store.put(body.data, body.mimeType);
        jsonResponse(res, 201, meta);
      } catch (err: unknown) {
        if (err instanceof BodyTooLarge) {
          jsonResponse(res, 413, { error: "Request body too large" });
          return true;
        }
        jsonResponse(res, 400, { error: err instanceof Error ? err.message : String(err) });
      }
      return true;
    }

    // GET /attachments/:id?sessionId=
    if (req.method === "GET") {
      const match = url.pathname.match(/^\/attachments\/([^/]+)$/);
      if (match) {
        try {
          const id = decodeURIComponent(match[1]!);
          const sessionId = url.searchParams.get("sessionId");
          if (!sessionId) {
            jsonResponse(res, 400, { error: "sessionId query parameter is required" });
            return true;
          }

          const store = storeFor(sessionId);
          const result = await store.get(id);
          if (!result) {
            // 404 for both "unknown id" and "wrong session" — see file header.
            jsonResponse(res, 404, { error: "Not found" });
            return true;
          }

          const bytes = Buffer.from(result.data, "base64");
          res.writeHead(200, {
            "Content-Type": result.mimeType,
            "Content-Length": bytes.byteLength,
            ...corsHeaders,
          });
          res.end(bytes);
        } catch (err: unknown) {
          jsonResponse(res, 500, { error: err instanceof Error ? err.message : String(err) });
        }
        return true;
      }
    }

    return false;
  };
}
