/**
 * Shared file-reference shapes: parser output, settle-time annotations, and
 * the row-keyed sets the host serves and the chat UI renders.
 */

export interface FileRef {
  /** Project-relative path, normalized (no leading `./`). */
  path: string;
  /** 1-based start line, from `path:42`, `path#L42` and friends. */
  line?: number;
  /** 1-based inclusive end line of a range ref (`path:10-20`, `path#L42-L50`). */
  endLine?: number;
}

export interface RefAnnotation extends FileRef {
  /** Character offsets of the inline-code content within its block text. */
  start: number;
  end: number;
  /** How the ref resolved: full path confirmed on disk, or a unique session-fact match. */
  source: "exact" | "session";
}

export interface RowRefSet {
  /** Feed row key: `${messageId}:a${segmentIndex}` (groupFeedEntries convention). */
  rowKey: string;
  /** blockRefs[i] holds the refs inside the row's i-th text block. */
  blockRefs: RefAnnotation[][];
}
