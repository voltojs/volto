/**
 * Settle-time file reference annotations for one session: folds the
 * conversation view, collects the files the session's tools touched, and
 * resolves inline-code refs where identity is known (on disk, or a unique
 * session-fact match). Ambiguity yields no annotation.
 */

import * as fs from "node:fs/promises";
import * as nodePath from "node:path";
import type { TranscriptEventInput } from "@voltojs/core";
import { groupConversationBlocks, type ConversationMessage } from "@voltojs/sdk/sse";
import { resolveMessageRefs, type RowRefSet } from "@voltojs/sdk/file-refs";
import { resolveWithinRoot } from "./fs/files.js";

export class UnknownProjectError extends Error {}
export class UnknownSessionError extends Error {}

export interface FileRefsSessionSnapshot {
  events: readonly TranscriptEventInput[];
  messages: readonly ConversationMessage[];
  /** The session's own project binding (ChatSessionMeta.projectId). */
  projectId?: string | null;
}

export interface FileRefsServiceOptions {
  projectRootFor: (projectId: string) => Promise<string | undefined>;
  sessionFor: (sessionId: string) => Promise<FileRefsSessionSnapshot | undefined>;
}

export interface FileRefsService {
  getRefs(projectId: string, sessionId: string): Promise<RowRefSet[]>;
}

/**
 * Files the session's tool calls referenced, project-relative. Absolute
 * paths under the root are relativized; anything outside is dropped. Turn
 * keys match the `${turn}` head of message ids so same-turn locality lines
 * up with the row fold.
 */
const TOUCHED_FILE_TOOLS = new Set(["read_file", "write_file", "edit_file"]);

export function collectTouchedFiles(
  events: readonly TranscriptEventInput[],
  projectRoot: string,
): { all: string[]; byTurn: Map<string, string[]> } {
  const all = new Set<string>();
  const byTurn = new Map<string, Set<string>>();
  const root = projectRoot.replace(/[/\\]+$/, "");
  for (const event of events) {
    if (event.type !== "tool_call") continue;
    const data = event.data as { name?: string; input?: Record<string, unknown> };
    // Only the file tools touch files: grep/glob path args are directory
    // scopes, and a directory in the touched set can only produce chips
    // that open onto error previews.
    if (data.name === undefined || !TOUCHED_FILE_TOOLS.has(data.name)) continue;
    const raw = data.input?.["path"] ?? data.input?.["file_path"];
    if (typeof raw !== "string" || raw === "") continue;
    let rel: string;
    if (nodePath.isAbsolute(raw)) {
      const resolved = nodePath.relative(root, raw);
      if (resolved === "" || resolved.startsWith("..") || nodePath.isAbsolute(resolved)) continue;
      rel = resolved.split(nodePath.sep).join("/");
    } else {
      rel = raw.replace(/^(?:\.\/)+/, "");
      if (rel === "" || rel.startsWith("..")) continue;
    }
    all.add(rel);
    const key = String(event.turn ?? "");
    let set = byTurn.get(key);
    if (set === undefined) {
      set = new Set<string>();
      byTurn.set(key, set);
    }
    set.add(rel);
  }
  return {
    all: [...all],
    byTurn: new Map([...byTurn].map(([k, v]) => [k, [...v]])),
  };
}

export function createFileRefsService(opts: FileRefsServiceOptions): FileRefsService {
  // Recompute whenever the durable log grows; resolved annotations are
  // session memory, recomputed after reload — nothing is persisted.
  const cache = new Map<string, { events: number; refs: RowRefSet[] }>();
  return {
    async getRefs(projectId: string, sessionId: string): Promise<RowRefSet[]> {
      const snapshot = await opts.sessionFor(sessionId);
      if (snapshot === undefined) throw new UnknownSessionError(sessionId);
      // The session's own project binding wins over the request's projectId:
      // a mismatched pair must never resolve under someone else's root.
      const owningProjectId = snapshot.projectId ?? projectId;
      const projectRoot = await opts.projectRootFor(owningProjectId);
      if (projectRoot === undefined) throw new UnknownProjectError(owningProjectId);

      const cacheKey = `${owningProjectId}:${sessionId}`;
      const cached = cache.get(cacheKey);
      if (cached !== undefined && cached.events === snapshot.events.length) return cached.refs;

      const rows: Array<{ rowKey: string; turn: string; blocks: string[] }> = [];
      for (const message of snapshot.messages) {
        if (message.role !== "assistant") continue;
        const segments = groupConversationBlocks(message.blocks);
        segments.forEach((segment, index) => {
          if (segment.kind !== "answer") return;
          rows.push({
            // Same key groupFeedEntries assigns: `${message.id}:a${segmentIndex}`.
            rowKey: `${message.id}:a${index}`,
            turn: message.id.split(":")[0] ?? message.id,
            blocks: segment.blocks.map((b) => (b.type === "text" ? b.text : "")),
          });
        });
      }

      const touched = collectTouchedFiles(snapshot.events, projectRoot);
      const refs = await resolveMessageRefs({
        rows,
        touchedByTurn: touched.byTurn,
        touchedAll: touched.all,
        exists: async (rel: string): Promise<boolean> => {
          try {
            const st = await fs.stat(await resolveWithinRoot(projectRoot, rel));
            return st.isFile();
          } catch {
            return false;
          }
        },
      });
      cache.set(cacheKey, { events: snapshot.events.length, refs });
      return refs;
    },
  };
}
