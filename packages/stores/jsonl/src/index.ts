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
  TranscriptReader,
  TranscriptStore,
} from "@volto/core";
import * as fs from "node:fs/promises";
import * as path from "node:path";

// v3: assistant_message dropped its `reasoning` string field in favor of a
// `reasoning` content block plus `source`/`modelMeta`. A v2 log read by this
// build would silently drop older sessions' reasoning (projections now read
// it only from content blocks) with no error — the version bump makes that
// rejected explicitly by the mismatch check below instead.
const SCHEMA_VERSION = 3 as const;

export type { ChatSessionMeta };

/** One line of a v3 session file. */
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
  /**
   * How long `deleteSession` will wait for in-flight appends to drain before
   * returning anyway (default 5000ms). Exposed mainly so tests can shrink it
   * without waiting out the production default; the tombstone itself is not
   * bounded by this value (see `deleteSession`).
   */
  appendDrainTimeoutMs?: number;
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
  const { directory, appendDrainTimeoutMs = 5000 } = opts;

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

  /**
   * Tombstone of sessions currently being deleted. `appendEventBatch`
   * resolves its target file path *before* entering the per-file write
   * queue (see that function's comment), so a delete can land in the gap
   * between an append's path resolution and its queued write. Without this
   * flag, that queued write would find no file (ENOENT swallowed by
   * `readLinesAt`), restart `seq` at 0, and `fs.appendFile` would recreate
   * the file with just the tail of that batch — a structurally valid but
   * truncated resurrection of a deleted session.
   *
   * The flag is checked *inside* the queued callback (i.e. holding the same
   * per-file lock appends use), which is what makes it authoritative
   * regardless of queue ordering between the delete's unlink task and a
   * straggling append's write task.
   *
   * Bounding: an id is added here before `deleteSession` unlinks. Actual
   * removal is decoupled from what `deleteSession` itself waits on — see the
   * comment on `deleteSession` for why, and `waitForAppendsToDrain` /
   * `APPEND_DRAIN_TIMEOUT_MS` for the two halves of that split.
   */
  const tombstonedSessions = new Set<string>();

  /** Per-session in-flight `appendEventBatch` bookkeeping, used to bound `tombstonedSessions`. */
  interface InFlightAppends {
    count: number;
    waiters: Array<() => void>;
  }
  const inFlightAppends = new Map<string, InFlightAppends>();

  function beginAppend(sessionId: string): void {
    const entry = inFlightAppends.get(sessionId);
    if (entry) {
      entry.count += 1;
    } else {
      inFlightAppends.set(sessionId, { count: 1, waiters: [] });
    }
  }

  function endAppend(sessionId: string): void {
    const entry = inFlightAppends.get(sessionId);
    if (!entry) return;
    entry.count -= 1;
    if (entry.count <= 0) {
      inFlightAppends.delete(sessionId);
      for (const wake of entry.waiters) wake();
    }
  }

  /**
   * Resolves once every `appendEventBatch` call for `sessionId` that is
   * currently in flight — including ones that start *after* this is called,
   * for as long as the count never actually reaches zero — has finished.
   * This is a genuine, unbounded drain: on its own it is what the
   * `deleteSession` bug report described ("can hang forever" for a session
   * that keeps streaming appends in). It is only ever awaited from a
   * context that does not block a caller on it — see `deleteSession`.
   */
  function waitForAppendsToDrain(sessionId: string): Promise<void> {
    const entry = inFlightAppends.get(sessionId);
    if (!entry) return Promise.resolve();
    return new Promise((resolve) => entry.waiters.push(resolve));
  }

  function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
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
    beginAppend(sessionId);
    try {
      const target = await resolveWritePath(workspacePath, sessionId);
      await fs.mkdir(path.dirname(target), { recursive: true });
      await enqueue(target, async () => {
        // Authoritative check: holds the same per-file lock as the read/write
        // below, so it sees a delete that landed anytime before this task
        // reached the front of the queue. A tombstoned session's append is a
        // silent no-op, matching the "best-effort recorder" semantics the
        // Runner's `bestEffortAppend` already relies on.
        if (tombstonedSessions.has(sessionId)) return;
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
    } finally {
      endAppend(sessionId);
    }
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
      // Mark the tombstone *before* resolving the file, not after: a session
      // deleted while its very first `appendEventBatch` call is still
      // resolving its write path (or blocked on `fs.mkdir`) has no file on
      // disk yet, so `findExistingFilePath` would return null and an early
      // return here would skip tombstoning entirely — leaving that in-flight
      // append free to create the file once it resumes, resurrecting a
      // session that was supposedly deleted. Tombstoning unconditionally
      // closes that gap: whichever target the racing append resolves to, its
      // queued callback checks `tombstonedSessions` before writing (see the
      // comment on that set above).
      tombstonedSessions.add(sessionId);
      try {
        const target = await findExistingFilePath(sessionId);
        if (target) {
          // Routing the unlink through the same `enqueue(target, ...)` queue
          // as appends is what prevents it from interleaving with a queued
          // append's read-modify-write.
          await enqueue(target, async () => {
            try {
              await fs.unlink(target);
            } catch (err: unknown) {
              if (!isEnoent(err)) throw err;
            }
          });
        }
      } finally {
        // `deleteSession`'s own returned promise is bounded by a timeout,
        // not by a full drain: a session mid-streaming-turn can keep the
        // in-flight append count continuously non-zero (the recorder
        // appends event by event), so awaiting an unbounded drain here would
        // hang this call — and the `DELETE /sessions/:id` handler that
        // awaits it — for as long as the stream keeps going.
        //
        // Tombstone removal itself is NOT bounded by that same timeout:
        // forcing it off early would let an append that was genuinely
        // already in flight — just not finished yet — land after the
        // tombstone was gone, which is exactly the resurrection this
        // mechanism exists to prevent. `fullyDrained` chains the removal
        // onto the real, unbounded drain and keeps running in the
        // background regardless of which side of the race below wins, so a
        // pathologically long-running stream cannot hold this call hostage
        // while every append that does eventually settle still sees an
        // accurate tombstone. Calling `waitForAppendsToDrain` here — after
        // the find+unlink above, in a `finally` so it also runs if that
        // threw — is what keeps the tombstone covering that whole window
        // unconditionally, which is what the "delete before the file has
        // ever been created" fix depends on.
        const fullyDrained = waitForAppendsToDrain(sessionId).then(() => {
          tombstonedSessions.delete(sessionId);
        });
        await Promise.race([fullyDrained, sleep(appendDrainTimeoutMs)]);
      }
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

/**
 * Narrows a full store instance into the read-side port shape.
 * One underlying directory tree; this is a view over it.
 */
export function asTranscriptReader(store: JsonlSessionStore): TranscriptReader {
  return { readEvents: (sessionId) => store.readEvents(sessionId) };
}
