/**
 * `file://` URI helpers shared by the LSP contract and its implementations.
 *
 * These were previously duplicated (and wrong) inside `lsp-tools.ts`: a naive
 * `file://${path}` round-trip mangles paths containing spaces or non-ASCII
 * characters. Both directions here are strict counterparts of each other, so
 * `uriToFile(fileToUri(p)) === p` for any absolute POSIX path.
 *
 * Node-free on purpose: this package's tool contract must stay portable, and
 * the encoding can be expressed exactly with `encodeURIComponent` plus the few
 * URI delimiters that must NOT be escaped inside a path segment.
 */

/** Characters that are valid in a URI path and must survive encoding. */
const PATH_SEGMENT_SAFE = /[!'()*\-._~:@$&+,;=/]/g;

/**
 * Encode one path segment for the path component of a `file://` URI.
 * `encodeURIComponent` leaves `!'()*` unescaped; they are legal path
 * characters, so keeping them is safe as well as shorter.
 */
function encodeSegment(segment: string): string {
  return encodeURIComponent(segment).replace(PATH_SEGMENT_SAFE, (c) => c);
}

/**
 * Convert an absolute filesystem path to a `file://` URI.
 *
 * Windows separators are normalized to `/` so a single implementation is
 * correct on every platform (drive letters become `file:///C:/...`).
 */
export function fileToUri(filePath: string): string {
  if (!filePath.startsWith("/")) {
    throw new TypeError(`fileToUri requires an absolute path, received "${filePath}"`);
  }
  const normalized = filePath.replace(/\\/g, "/");
  const encoded = normalized.split("/").map(encodeSegment).join("/");
  return `file://${encoded}`;
}

/** Percent-decode a URI component, preferring strict decoding over a literal. */
function decodeComponent(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

/**
 * Convert a `file://` URI back to a filesystem path.
 *
 * Authority (e.g. `localhost`) and query/fragment parts are dropped: an LSP
 * location URI names a document, and the host authority is not part of the
 * path. Percent-encoded octets are decoded, so `file:///tmp/%E4%B8%AD/a%20b.ts`
 * becomes `/tmp/中/a b.ts` rather than its encoded spelling.
 */
export function uriToFile(uri: string): string {
  let rest = uri;
  const schemeEnd = rest.indexOf("://");
  if (schemeEnd !== -1) {
    const scheme = rest.slice(0, schemeEnd).toLowerCase();
    if (scheme !== "file") {
      throw new TypeError(`uriToFile requires a file:// URI, received "${uri}"`);
    }
    rest = rest.slice(schemeEnd + 3);
    const authorityEnd = rest.indexOf("/");
    rest = authorityEnd === -1 ? "" : rest.slice(authorityEnd);
  }

  const queryStart = rest.search(/[?#]/);
  if (queryStart !== -1) rest = rest.slice(0, queryStart);

  const decoded = decodeComponent(rest);
  // Windows drive form: file:///C:/dir/file.ts → C:/dir/file.ts
  if (/^\/[A-Za-z]:\//.test(decoded)) return decoded.slice(1);
  return decoded;
}
