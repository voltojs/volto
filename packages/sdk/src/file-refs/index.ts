/**
 * `@volto/sdk/file-refs` — shared file-reference parsing and settle-time
 * annotation. Consumed by the web chat UI (chips, tool rows, links) and by
 * gateway (resolveMessageRefs), so both ends share one parser.
 */

export * from "./types.js";
export * from "./parse.js";
export * from "./annotate.js";
