/**
 * JSONL-backed chat session store.
 *
 * Modeled on the append-only transcript convention used by CLI agent
 * harnesses (Claude Code, DeepSeek's coding agent): one `.jsonl` file per
 * session, one JSON object per line, each line linked to the previous via
 * `parentUuid` so the file is a chain rather than an unordered bag of facts.
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

import type { Message, ChatSessionMeta, RawTrajectoryEntry, TranscriptStore } from "@volto/core";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as crypto from "node:crypto";

const SCHEMA_VERSION = 1 as const;

export type { ChatSessionMeta };

interface RecordBase {
  uuid: string;
  parentUuid: string | null;
  sessionId: string;
  timestamp: number;
  version: typeof SCHEMA_VERSION;
}

interface MetaLine extends RecordBase {
  type: "meta";
  meta: ChatSessionMeta;
}

interface MessageLine extends RecordBase {
  type: "message";
  message: Message;
}

interface ErrorLine extends RecordBase {
  type: "error";
  message: string;
}

interface TrajectoryLine extends RecordBase {
  type: "trajectory";
  entry: RawTrajectoryEntry;
}

type JsonlLine = MetaLine | MessageLine | ErrorLine | TrajectoryLine;

export interface ChatSessionRecord {
  sessionId: string;
  meta: ChatSessionMeta;
  messages: Message[];
  /**
   * Wall-clock time each entry in `messages` was appended, same length and
   * order as `messages`. A separate parallel array (rather than wrapping each
   * message) so `messages` stays a plain `Message[]` — the shape agent
   * rebuild's `initialMessages` seeding needs — while still letting a
   * display-oriented reader recover per-message timestamps.
   */
  messageTimestamps: number[];
  errors: Array<{ message: string; timestamp: number }>;
  createdAt: number;
  updatedAt: number;
}

export interface JsonlSessionStore {
  /**
   * Appends (or updates) the session's config binding / title.
   * `workspacePath` is a hint used only to place a *new* session's file
   * under the matching workspace directory — an existing session's file,
   * wherever it already lives, always wins (see `findExistingFilePath`), so
   * a caller that does not know the workspace path yet (or passes a
   * different one by mistake) can never fragment a session's history across
   * two files.
   */
  appendMeta(workspacePath: string | null, sessionId: string, meta: ChatSessionMeta): Promise<void>;
  /** Appends one line per message, in order. A no-op for an empty array. */
  appendMessages(workspacePath: string | null, sessionId: string, messages: Message[]): Promise<void>;
  /** Appends a turn-level error, without disturbing message history. */
  appendError(workspacePath: string | null, sessionId: string, message: string): Promise<void>;
  /** Appends one raw trajectory entry. Never folded into `ChatSessionRecord` — read separately when the trajectory-review feature resumes. */
  appendTrajectoryEntry(workspacePath: string | null, sessionId: string, entry: RawTrajectoryEntry): Promise<void>;
  /** Replays a session's file into its current meta + full history — searches every workspace directory. */
  readSession(sessionId: string): Promise<ChatSessionRecord | undefined>;
  /** Replays every session file across every workspace directory (plus any unbound sessions at the top level). */
  listSessions(): Promise<ChatSessionRecord[]>;
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
  // never interleave their lines, and so each append sees the previous
  // line's uuid (for parentUuid) even when calls race.
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
   * Reads and parses whatever lines exist at `target`, silently skipping
   * malformed ones (e.g. a partial line left by a crash mid-write) instead
   * of failing the whole read over one bad line.
   */
  async function readLinesAt(target: string): Promise<JsonlLine[]> {
    let raw: string;
    try {
      raw = await fs.readFile(target, "utf-8");
    } catch (err: unknown) {
      if (isEnoent(err)) return [];
      throw err;
    }
    const lines: JsonlLine[] = [];
    for (const line of raw.split("\n")) {
      if (!line.trim()) continue;
      try {
        lines.push(JSON.parse(line) as JsonlLine);
      } catch {
        // Skip a corrupt/partial line rather than losing the whole session.
      }
    }
    return lines;
  }

  function makeBase(sessionId: string, parentUuid: string | null): RecordBase {
    return {
      uuid: crypto.randomUUID(),
      parentUuid,
      sessionId,
      timestamp: Date.now(),
      version: SCHEMA_VERSION,
    };
  }

  async function appendLines(
    workspacePath: string | null,
    sessionId: string,
    build: (parentUuid: string | null) => JsonlLine[],
  ): Promise<void> {
    const target = await resolveWritePath(workspacePath, sessionId);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await enqueue(target, async () => {
      const existing = await readLinesAt(target);
      const parentUuid = existing.length > 0 ? existing[existing.length - 1]!.uuid : null;
      const lines = build(parentUuid);
      if (lines.length === 0) return;
      const text = lines.map((line) => JSON.stringify(line)).join("\n") + "\n";
      await fs.appendFile(target, text, "utf-8");
    });
  }

  /** Folds a session's lines into its current meta + full message history. */
  function reduce(lines: JsonlLine[]): ChatSessionRecord {
    let meta: ChatSessionMeta = {
      projectId: null,
      providerId: null,
      modelId: null,
      permissionMode: null,
    };
    const messages: Message[] = [];
    const messageTimestamps: number[] = [];
    const errors: Array<{ message: string; timestamp: number }> = [];
    for (const line of lines) {
      if (line.type === "meta") meta = { ...meta, ...line.meta };
      if (line.type === "message") {
        messages.push(line.message);
        messageTimestamps.push(line.timestamp);
      }
      if (line.type === "error") errors.push({ message: line.message, timestamp: line.timestamp });
    }
    return {
      sessionId: lines[0]!.sessionId,
      meta,
      messages,
      messageTimestamps,
      errors,
      createdAt: lines[0]!.timestamp,
      updatedAt: lines[lines.length - 1]!.timestamp,
    };
  }

  async function readAndReduce(target: string): Promise<ChatSessionRecord | undefined> {
    const lines = await readLinesAt(target);
    if (lines.length === 0) return undefined;
    return reduce(lines);
  }

  return {
    async appendMeta(workspacePath, sessionId, meta) {
      await appendLines(workspacePath, sessionId, (parentUuid) => [
        { ...makeBase(sessionId, parentUuid), type: "meta", meta },
      ]);
    },

    async appendMessages(workspacePath, sessionId, messages) {
      if (messages.length === 0) return;
      await appendLines(workspacePath, sessionId, (initialParent) => {
        let parentUuid = initialParent;
        return messages.map((message): MessageLine => {
          const base = makeBase(sessionId, parentUuid);
          parentUuid = base.uuid;
          return { ...base, type: "message", message };
        });
      });
    },

    async appendError(workspacePath, sessionId, message) {
      await appendLines(workspacePath, sessionId, (parentUuid) => [
        { ...makeBase(sessionId, parentUuid), type: "error", message },
      ]);
    },

    async appendTrajectoryEntry(workspacePath, sessionId, entry) {
      await appendLines(workspacePath, sessionId, (parentUuid) => [
        { ...makeBase(sessionId, parentUuid), type: "trajectory", entry },
      ]);
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

      for (const entry of entries) {
        if (entry.isDirectory()) {
          const subDir = path.join(directory, entry.name);
          for (const file of await fs.readdir(subDir)) {
            if (!file.endsWith(".jsonl")) continue;
            const record = await readAndReduce(path.join(subDir, file));
            if (record) records.push(record);
          }
        } else if (entry.name.endsWith(".jsonl")) {
          const record = await readAndReduce(path.join(directory, entry.name));
          if (record) records.push(record);
        }
      }
      return records;
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
export function scopeToWorkspace(store: JsonlSessionStore, workspacePath: string | null): TranscriptStore {
  return {
    appendMeta: (sessionId, meta) => store.appendMeta(workspacePath, sessionId, meta),
    appendMessages: (sessionId, messages) => store.appendMessages(workspacePath, sessionId, messages),
    appendError: (sessionId, message) => store.appendError(workspacePath, sessionId, message),
    appendTrajectoryEntry: (sessionId, entry) => store.appendTrajectoryEntry(workspacePath, sessionId, entry),
  };
}
