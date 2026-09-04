/**
 * JSONL-backed chat session store.
 *
 * Modeled on the append-only transcript convention used by CLI agent
 * harnesses (Claude Code, DeepSeek's coding agent): one `.jsonl` file per
 * session, one JSON object per line, each line carrying a store-assigned
 * `seq` that is monotonic and contiguous from 0, so the file's line order is
 * verifiably a total order rather than an unordered bag of facts.
 * Sessions are further grouped one directory per workspace — same convention
 * Claude Code uses for its own per-project transcript directories — with the
 * workspace's absolute path encoded into a filesystem-safe directory name
 * (every character outside [a-zA-Z0-9] becomes `-`).
 *
 * This is deliberately not an implementation of `@volto/core`'s
 * `SessionStore` port. That port is a whole-`AgentState` snapshot store built
 * for HITL checkpoint/resume and keyed by a per-turn id; this store is
 * append-only, keyed by the host's own chat session id, and exists to record
 * what a session's messages and config bindings were over its lifetime — a
 * durable transcript, not a resumable execution checkpoint.
 */

import type {
  ChatSessionMeta,
  TranscriptEvent,
  TranscriptEventInput,
  TranscriptStore,
} from "@volto/core";
import * as fs from "node:fs/promises";
import * as path from "node:path";

const SCHEMA_VERSION = 2 as const;

export type { ChatSessionMeta };

/** One line of a v2 session file. */
interface EventLine {
  version: typeof SCHEMA_VERSION;
  sessionId: string;
  event: TranscriptEvent;
}

/** Thrown when a session file was written by a different format version. */
export class TranscriptFormatError extends Error {
  constructor(
    readonly filePath: string,
    readonly foundVersion: unknown,
  ) {
    super(
      `Session file "${filePath}" is format version ${String(foundVersion)}; ` +
        `this build reads version ${SCHEMA_VERSION} only. There is no migration path — ` +
        `the session must be re-created.`,
    );
    this.name = "TranscriptFormatError";
  }
}

export interface ChatSessionRecord {
  sessionId: string;
  meta: ChatSessionMeta & {
    parentSessionId?: string;
    delegationDepth?: number;
    origin?: "subagent";
  };
  /**
   * The raw log. Callers that need conversation history run it through
   * `projectMessages()` themselves — this package only does I/O, and the
   * stores-* rule is that it consumes core's interface types only.
   */
  events: TranscriptEvent[];
  createdAt: number;
  updatedAt: number;
}

export interface JsonlSessionStore {
  /** Appends a batch of events, assigning contiguous seq in array order. Empty batch is a no-op. */
  appendEvents(
    workspacePath: string | null,
    sessionId: string,
    events: readonly TranscriptEventInput[],
  ): Promise<void>;
  /** Reads a session's raw event log. Empty array when the session does not exist. */
  readEvents(sessionId: string): Promise<TranscriptEvent[]>;
  /** Replays a session's file into its current meta + full history — searches every workspace directory. */
  readSession(sessionId: string): Promise<ChatSessionRecord | undefined>;
  /** Replays every session file. A file this build cannot read is reported in `skipped`, not thrown. */
  listSessions(): Promise<{
    records: ChatSessionRecord[];
    skipped: Array<{ filePath: string; reason: string }>;
  }>;
  /** Deletes a session's file, wherever it lives. A no-op if it does not exist. */
  deleteSession(sessionId: string): Promise<void>;
}

export interface JsonlStoreOptions {
  /** Directory holding one subdirectory per workspace, each with one `<sessionId>.jsonl` per session. */
  directory: string;
}

function isEnoent(err: unknown): boolean {
  return err instanceof Error && "code" in err && (err as NodeJS.ErrnoException).code === "ENOENT";
}

/** Sanitizes a session id into a safe filename (mirrors @volto/store-file). */
function fileNameFor(sessionId: string): string {
  const safe = sessionId.replace(/[^a-zA-Z0-9_-]/g, "_");
  return `${safe}.jsonl`;
}

/**
 * Encodes an absolute workspace path into a filesystem-safe directory name,
 * the same substitution Claude Code uses for its own per-project transcript
 * directories: every character outside [a-zA-Z0-9] becomes `-`. Like that
 * convention, this is lossy — two workspace paths that differ only in
 * characters this collapses to `-` will land in the same directory.
 */
export function encodeWorkspaceName(workspacePath: string): string {
  return workspacePath.replace(/[^a-zA-Z0-9]/g, "-");
}

export function createStore(opts: JsonlStoreOptions): JsonlSessionStore {
  const { directory } = opts;

  // Per-file write queues so concurrent appends to the same session's file
  // never interleave their lines. This is also what makes seq assignment
  // atomic: appendEventBatch reads the last-assigned seq and writes its
  // batch inside this queue's callback, so no other append can read the
  // same "last seq" before this one's write lands.
  const writeQueues = new Map<string, Promise<void>>();

  function enqueue(filePath: string, task: () => Promise<void>): Promise<void> {
    const previous = writeQueues.get(filePath) ?? Promise.resolve();
    const next = previous.then(task, task);
    // Swallow here so one failed write doesn't wedge the queue for later
    // callers on the same file; the rejection still propagates to the
    // caller that triggered it via the returned `next`.
    writeQueues.set(filePath, next.then(
      () => undefined,
      () => undefined,
    ));
    return next;
  }

  async function exists(target: string): Promise<boolean> {
    try {
      await fs.stat(target);
      return true;
    } catch {
      return false;
    }
  }

  function defaultFilePath(workspacePath: string | null, sessionId: string): string {
    const dir = workspacePath ? path.join(directory, encodeWorkspaceName(workspacePath)) : directory;
    return path.join(dir, fileNameFor(sessionId));
  }

  /**
   * Finds an existing session's file, searching the top level (unbound
   * sessions) and then every workspace subdirectory. Returns null if the
   * session has never been written.
   */
  async function findExistingFilePath(sessionId: string): Promise<string | null> {
    const name = fileNameFor(sessionId);
    const rootCandidate = path.join(directory, name);
    if (await exists(rootCandidate)) return rootCandidate;

    let entries: Array<{ name: string; isDirectory(): boolean }>;
    try {
      entries = await fs.readdir(directory, { withFileTypes: true });
    } catch (err: unknown) {
      if (isEnoent(err)) return null;
      throw err;
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const candidate = path.join(directory, entry.name, name);
      if (await exists(candidate)) return candidate;
    }
    return null;
  }

  /** The file a write should target: the session's existing file if it has one, else a fresh path under `workspacePath`. */
  async function resolveWritePath(workspacePath: string | null, sessionId: string): Promise<string> {
    const existing = await findExistingFilePath(sessionId);
    return existing ?? defaultFilePath(workspacePath, sessionId);
  }

  /**
   * Reads and parses whatever lines exist at `target`, skipping malformed
   * ones (e.g. a partial line left by a crash mid-write) rather than failing
   * the whole read over one bad line. A line whose `version` does not match
   * is a different matter entirely — that one throws.
   */
  async function readLinesAt(target: string): Promise<EventLine[]> {
    let raw: string;
    try {
      raw = await fs.readFile(target, "utf-8");
    } catch (err: unknown) {
      if (isEnoent(err)) return [];
      throw err;
    }
    const lines: EventLine[] = [];
    for (const line of raw.split("\n")) {
      if (!line.trim()) continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        // A torn/partial line — skip it rather than losing the session.
        continue;
      }
      const candidate = parsed as Partial<EventLine>;
      if (candidate.version !== SCHEMA_VERSION) {
        throw new TranscriptFormatError(target, candidate.version);
      }
      lines.push(candidate as EventLine);
    }
    return lines;
  }

  /**
   * Appends a batch, assigning contiguous seq. The per-file queue is what
   * makes seq assignment safe: reading the last line and writing the next
   * batch happen without another append interleaving.
   */
  async function appendEventBatch(
    workspacePath: string | null,
    sessionId: string,
    events: readonly TranscriptEventInput[],
  ): Promise<void> {
    if (events.length === 0) return;
    const target = await resolveWritePath(workspacePath, sessionId);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await enqueue(target, async () => {
      const existing = await readLinesAt(target);
      let nextSeq = existing.length > 0 ? existing[existing.length - 1]!.event.seq + 1 : 0;
      const lines: EventLine[] = events.map((input) => ({
        version: SCHEMA_VERSION,
        sessionId,
        event: { ...input, seq: nextSeq++ } as TranscriptEvent,
      }));
      const text = lines.map((line) => JSON.stringify(line)).join("\n") + "\n";
      await fs.appendFile(target, text, "utf-8");
    });
  }

  /** Folds a session's events into its current meta. */
  function reduce(sessionId: string, events: TranscriptEvent[]): ChatSessionRecord {
    let meta: ChatSessionRecord["meta"] = {
      projectId: null,
      providerId: null,
      modelId: null,
      permissionMode: null,
    };
    for (const event of events) {
      if (event.type === "session_meta") {
        meta = { ...meta, ...(event.data as ChatSessionRecord["meta"]) };
      }
    }
    return {
      sessionId,
      meta,
      events,
      createdAt: events[0]!.time,
      updatedAt: events[events.length - 1]!.time,
    };
  }

  async function readAndReduce(target: string): Promise<ChatSessionRecord | undefined> {
    const lines = await readLinesAt(target);
    if (lines.length === 0) return undefined;
    return reduce(lines[0]!.sessionId, lines.map((line) => line.event));
  }

  return {
    async appendEvents(workspacePath, sessionId, events) {
      await appendEventBatch(workspacePath, sessionId, events);
    },

    async readEvents(sessionId) {
      const target = await findExistingFilePath(sessionId);
      if (!target) return [];
      const lines = await readLinesAt(target);
      return lines.map((line) => line.event);
    },

    async readSession(sessionId) {
      const target = await findExistingFilePath(sessionId);
      if (!target) return undefined;
      return readAndReduce(target);
    },

    async listSessions() {
      await fs.mkdir(directory, { recursive: true });
      const entries = await fs.readdir(directory, { withFileTypes: true });
      const records: ChatSessionRecord[] = [];
      const skipped: Array<{ filePath: string; reason: string }> = [];

      /**
       * A single stale file must not take down the whole listing — this is
       * the one place the "reject an unreadable file" rule is softened, and
       * the caller learns about it through `skipped` rather than silence.
       */
      const readOne = async (filePath: string): Promise<void> => {
        try {
          const record = await readAndReduce(filePath);
          if (record) records.push(record);
        } catch (err: unknown) {
          if (err instanceof TranscriptFormatError) {
            skipped.push({ filePath, reason: err.message });
            return;
          }
          throw err;
        }
      };

      for (const entry of entries) {
        if (entry.isDirectory()) {
          const subDir = path.join(directory, entry.name);
          for (const file of await fs.readdir(subDir)) {
            if (!file.endsWith(".jsonl")) continue;
            await readOne(path.join(subDir, file));
          }
        } else if (entry.name.endsWith(".jsonl")) {
          await readOne(path.join(directory, entry.name));
        }
      }
      return { records, skipped };
    },

    async deleteSession(sessionId) {
      const target = await findExistingFilePath(sessionId);
      if (target) await fs.unlink(target);
    },
  };
}

/**
 * Narrows a full, workspace-routing `JsonlSessionStore` instance into a
 * `TranscriptStore` bound to one fixed `workspacePath` — the shape
 * `createAgent({ chatStore })` accepts. One underlying store instance /
 * one directory tree; this is a view over it, not a second instance.
 */
export function scopeToWorkspace(
  store: JsonlSessionStore,
  workspacePath: string | null,
): TranscriptStore {
  return {
    appendEvents: (sessionId, events) => store.appendEvents(workspacePath, sessionId, events),
  };
}
