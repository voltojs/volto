/**
 * Which files of a Next.js static export belong in the staged site.
 *
 * Kept free of I/O and of any executable side effects so the gateway tests can
 * import the rule without running the copy step.
 */

/** Top-level export directory Next uses for its own not-found route. */
const NOT_FOUND_PREFIX = "_not-found/";

/**
 * Whether a web-root-relative path (`/`-separated, as `cpSync` filter
 * receives it) belongs in the staged site.
 *
 * Dropped: any `.txt` document at the web root (Next's RSC payloads) and
 * everything under `_not-found/` (the same payloads plus a duplicate
 * `index.html` the single-page shell never links to). `404.html` is kept: a
 * static host in front of the gateway uses it.
 *
 * @param {string} relPath path relative to the export root
 * @returns {boolean} true when the path ships and is served
 */
export function isShippedAsset(relPath) {
  const rel = relPath.replace(/^\/+/, "");
  // The directory entry itself (`cpSync` visits it before its children).
  if (rel === NOT_FOUND_PREFIX.slice(0, -1) || rel.startsWith(NOT_FOUND_PREFIX)) return false;
  return !(rel.endsWith(".txt") && !rel.includes("/"));
}