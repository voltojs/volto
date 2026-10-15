/**
 * Attachment upload/download routes for the web UI.
 *
 * POST /attachments  — store an image/text/PDF attachment, return its metadata
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
const IMAGE_MIME_TYPES = new Set([
  "image/png",
  "image/jpeg",
  "image/jpg",
  "image/gif",
  "image/webp",
]);

/**
 * Prefix rule for textual uploads (spec D1): markdown, csv, html and the
 * rest of text/* are accepted as a class — an enumeration would always lag
 * behind real-world subtype declarations.
 */
const TEXT_MIME_PREFIX = "text/";

/** Upload kind, which selects the base64 size cap (spec D3). */
type UploadKind = "image" | "text" | "pdf";

/**
 * Exact-match non-image MIME types accepted on upload (spec D1).
 * application/json is semantically textual but does not live under the
 * text/ prefix; application/pdf is named explicitly because the roadmap
 * calls for PDF-in-context.
 */
const EXACT_MIME_KINDS: Record<string, UploadKind> = {
  "application/json": "text",
  "application/pdf": "pdf",
};

/**
 * Classify an upload MIME type. Returns undefined for anything outside the
 * whitelist — binaries (zip, docx, video…) have no conversion path, so
 * accepting them would be a fake pass.
 */
function classifyUpload(mimeType: string): UploadKind | undefined {
  if (IMAGE_MIME_TYPES.has(mimeType)) return "image";
  if (mimeType.startsWith(TEXT_MIME_PREFIX)) return "text";
  return EXACT_MIME_KINDS[mimeType];
}

/** Base64 length caps by kind (spec D3): text/json 2 MiB, PDF and images 5 MiB. */
const MAX_BASE64_BY_KIND: Record<UploadKind, number> = {
  image: MAX_IMAGE_BASE64,
  text: 2 * 1024 * 1024,
  // PDF deliberately shares the image cap.
  pdf: MAX_IMAGE_BASE64,
};

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
          name?: string;
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

        const kind = classifyUpload(body.mimeType);
        if (!kind) {
          jsonResponse(res, 400, { error: `Unsupported mimeType: ${body.mimeType}` });
          return true;
        }

        if (body.data.length > MAX_BASE64_BY_KIND[kind]) {
          jsonResponse(res, 413, {
            error:
              kind === "image"
                ? "Image exceeds the maximum allowed size"
                : "Attachment exceeds the maximum allowed size",
          });
          return true;
        }

        const store = storeFor(body.sessionId);
        // The name is untrusted client input, model-visible only: record it
        // verbatim when it is a non-empty string, otherwise omit it entirely.
        const name = typeof body.name === "string" && body.name !== "" ? body.name : undefined;
        const meta = await store.put(body.data, body.mimeType, name !== undefined ? { name } : undefined);
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

          // storeFor throws on a sessionId that is not a single safe path
          // segment (e.g. "../escape"); that is client input, not a server fault.
          let store;
          try {
            store = storeFor(sessionId);
          } catch {
            jsonResponse(res, 400, { error: "Invalid sessionId" });
            return true;
          }
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
