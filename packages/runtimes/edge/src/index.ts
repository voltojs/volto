/**
 * Edge runtime adapters for volto.
 * Provides FileSystem (object storage) and Network (fetch) implementations
 * that work in Cloudflare Workers, Deno Deploy, and other edge runtimes.
 * No node:* dependencies.
 */

export { createEdgeFileSystem } from "./filesystem.js";
export type { EdgeFileSystemOptions, ObjectStorageBackend } from "./filesystem.js";

export { createEdgeNetwork } from "./network.js";
export type { EdgeNetworkOptions } from "./network.js";
