/**
 * Which build outputs a release must not reuse.
 *
 * Kept apart from `build-fresh.mjs` (which runs the build as an import side
 * effect) so it can be tested on a fixture tree.
 */
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { listPackageDirs } from "./publish-manifest.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * Every build output a release can accidentally reuse: each workspace
 * package's `dist/` and `tsconfig.tsbuildinfo`, plus the web export (`out/`)
 * and the gateway's staged copy of it (`web/`).
 *
 * @param {string} root repository root
 * @returns {string[]} absolute paths that must not survive into the build
 */
export function staleArtifacts(root = ROOT) {
  const paths = [];
  // A tree without a `packages/` directory is not a workspace yet: nothing to remove.
  const dirs = existsSync(join(root, "packages")) ? listPackageDirs(root) : [];
  for (const dir of dirs) {
    paths.push(join(dir, "dist"), join(dir, "tsconfig.tsbuildinfo"));
  }
  paths.push(join(root, "apps", "web", "out"));
  paths.push(join(root, "apps", "gateway", "web"));
  return paths.filter((path) => existsSync(path)).sort();
}
