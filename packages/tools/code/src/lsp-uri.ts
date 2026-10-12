/**
 * `file://` URI helpers shared by the LSP contract and its implementations.
 *
 * These were previously duplicated (and wrong) inside `lsp-tools.ts`: a naive
 * `file://${path}` round-trip mangles paths containing spaces or non-ASCII
 * characters. Both directions here are strict counterparts of each other, so
 * `uriToFile(fileToUri(p)) === p` for any absolute POSIX path.
 *
 * Node-free on purpose: this package's tool contract must stay portable, and
 * the encoding can be expressed exactly with `encodeURIComponent`.
 */

/**
 * Convert an absolute POSIX path to a `file://` URI.
 *
 * Every path segment is percent-encoded — including the characters
 * `encodeURIComponent` would leave alone (`!'()*`) — and the separators are
 * then restored. The result is canonical: `/tmp/中 a.ts` becomes
 * `file:///tmp/%E4%B8%AD%20a.ts`.
 *
 * A Windows path (`C:\dir\file.ts`) has no leading `/` and is rejected rather
 * than silently emitted as a malformed URI; add an explicit drive-letter
 * branch here if Windows support is ever needed.
 */
export function fileToUri(filePath: string): string {
  if (!filePath.startsWith("/")) {
    throw new TypeError(`fileToUri requires an absolute POSIX path, received "${filePath}"`);
  }
  return `file://${filePath.split("/").map(encodeURIComponent).join("/")}`;
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
 * becomes `/tmp/中/a b.ts` rather than its encoded spelling. A non-`file:`
 * scheme is rejected rather than decoded into a nonsense path.
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
