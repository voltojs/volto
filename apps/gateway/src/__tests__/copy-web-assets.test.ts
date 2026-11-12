/**
 * The staging step's filter: what an export writes is not all for the browser.
 *
 * `prepack` copies `apps/web/out` into `web/`, so whatever survives here is
 * what the published tarball ships — and therefore what the gateway's static
 * reader can hand out. Next also writes its RSC payload documents
 * (`__next._full.txt`, `__next._tree.txt`, `index.txt`) and a `_not-found/`
 * route; those are router internals the shell never links to, and served as
 * static files they would be one more thing answerable over the tunnel.
 */
import { describe, expect, it } from "vitest";
// The staging script is plain JS that also RUNS on import; its exported rule
// therefore has no declaration file, and this spec only needs the value.
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-expect-error -- untyped .mjs module
import { isShippedAsset } from "../../scripts/copy-web-assets.mjs";

describe("copy-web-assets · which export files ship", () => {
  it("drops the RSC payload documents at the web root", () => {
    for (const rel of ["/index.txt", "/__next._full.txt", "/__next._tree.txt", "/__next.__PAGE__.txt"]) {
      expect(isShippedAsset(rel), rel).toBe(false);
    }
  });

  it("drops everything under _not-found/", () => {
    for (const rel of ["/_not-found", "/_not-found/index.html", "/_not-found/__next._full.txt"]) {
      expect(isShippedAsset(rel), rel).toBe(false);
    }
  });

  it("keeps the app shell, the assets and 404.html", () => {
    for (const rel of [
      "/index.html",
      "/404.html",
      "/404/index.html",
      "/favicon.ico",
      "/volto-config.js",
      "/_next/static/chunks/a.js",
      // A `.txt` below the root is an asset bundle's own file, not a payload.
      "/_next/static/media/notes.txt",
    ]) {
      expect(isShippedAsset(rel), rel).toBe(true);
    }
  });

  it("is the rule the gateway's static reader applies at request time", async () => {
    // Two implementations, one contract: the copy step drops these files and
    // `serveStatic` refuses their paths, so a `web/` staged another way stays
    // closed too. The reader's own cases live in static-site.test.ts; this one
    // pins that both agree on the same names.
    const { isNotExposed } = await import("../static/serve.js");
    for (const rel of [
      "index.txt",
      "__next._full.txt",
      "__next._tree.txt",
      "_not-found/index.html",
      "index.html",
      "404.html",
      "favicon.ico",
      "_next/static/chunks/a.js",
    ]) {
      expect(isNotExposed(rel), rel).toBe(!isShippedAsset(rel));
    }
  });
});