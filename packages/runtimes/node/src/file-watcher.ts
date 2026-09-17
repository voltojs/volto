/**
 * Node FileWatcher adapter — implements the FileWatcher port on node:fs.watch.
 *
 * Registration paths resolve within the workspace root (same boundary as
 * createNodeFileSystem). Directory watches prefer `recursive: true` and
 * degrade to a non-recursive watch plus one level of subdirectories when
 * the platform rejects recursion. Events are debounced per watch, deduped
 * by relative path, optionally filtered by a simple glob, and delivered
 * as workspace-relative forward-slash paths. Host callback errors are
 * swallowed so they cannot crash the adapter.
 */

import fs from "node:fs";
import path from "node:path";
import type { FileWatchEvent, FileWatchRegistration, FileWatcher } from "@volto/core";

const DEFAULT_DEBOUNCE_MS = 200;

export interface NodeFileWatcherOptions {
  /** Absolute or relative workspace root. All watch paths stay inside it. */
  root: string;
}

export type NodeFileWatcher = FileWatcher & {
  dispose(): Promise<void>;
};

function normalizeSeparators(value: string): string {
  return value.replace(/\\/g, "/");
}

/** Minimal `*` / `**` / `?` matcher over `/`-separated relative paths. */
export function matchGlob(pattern: string, relativePath: string): boolean {
  const patternParts = pattern.split("/").filter((s) => s.length > 0);
  const pathParts = relativePath.split("/").filter((s) => s.length > 0);
  return matchParts(patternParts, pathParts);
}

function matchParts(pattern: string[], pathParts: string[]): boolean {
  const first = pattern[0];
  if (first === undefined) return pathParts.length === 0;
  if (first === "**") {
    const rest = pattern.slice(1);
    for (let i = 0; i <= pathParts.length; i++) {
      if (matchParts(rest, pathParts.slice(i))) return true;
    }
    return false;
  }
  const head = pathParts[0];
  if (head === undefined) return false;
  const rest = pattern.slice(1);
  if (first === "*") return matchParts(rest, pathParts.slice(1));
  if (matchSinglePart(first, head)) return matchParts(rest, pathParts.slice(1));
  return false;
}

function matchSinglePart(pattern: string, value: string): boolean {
  if (pattern === "*") return true;
  if (pattern.includes("*") || pattern.includes("?")) {
    const regex = new RegExp(
      "^" +
        pattern
          .replace(/[.+^${}()|[\]\\]/g, "\\$&")
          .replace(/\*/g, ".*")
          .replace(/\?/g, ".") +
        "$",
    );
    return regex.test(value);
  }
  return pattern === value;
}

interface PendingEvent {
  type: "change" | "rename";
  path: string;
}

interface ActiveWatch {
  id: string;
  watchers: fs.FSWatcher[];
  timer: ReturnType<typeof setTimeout> | null;
  pending: Map<string, PendingEvent>;
  debounceMs: number;
  glob: string | undefined;
  onEvents: (events: FileWatchEvent[]) => void;
}

export function createNodeFileWatcher(options: NodeFileWatcherOptions): NodeFileWatcher {
  const root = path.resolve(options.root);
  let nextId = 0;
  const watches = new Map<string, ActiveWatch>();

  function resolveWithinRoot(target: string): string {
    const resolved = path.resolve(root, target);
    const rel = path.relative(root, resolved);
    // Escapes the workspace if the relative path climbs out (..) or is absolute.
    if (rel === ".." || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) {
      throw new Error(`Path "${target}" escapes the workspace boundary.`);
    }
    return resolved;
  }

  function toRel(absPath: string): string {
    return normalizeSeparators(path.relative(root, absPath) || ".");
  }

  function joinRel(base: string, child: string): string {
    const normalizedChild = normalizeSeparators(child);
    if (!base || base === ".") return normalizedChild;
    return normalizeSeparators(`${base}/${normalizedChild}`);
  }

  function closeWatchers(watch: ActiveWatch): void {
    if (watch.timer) {
      clearTimeout(watch.timer);
      watch.timer = null;
    }
    watch.pending.clear();
    for (const w of watch.watchers) {
      try {
        w.close();
      } catch {
        // Already closed.
      }
    }
    watch.watchers.length = 0;
  }

  function flush(watch: ActiveWatch): void {
    watch.timer = null;
    if (watch.pending.size === 0) return;
    const batch: FileWatchEvent[] = [];
    for (const pending of watch.pending.values()) {
      if (watch.glob && !matchGlob(watch.glob, pending.path)) continue;
      let event: FileWatchEvent = { type: pending.type, path: pending.path };
      try {
        const stats = fs.statSync(path.resolve(root, pending.path));
        event = { type: pending.type, path: pending.path, mtime: stats.mtimeMs };
      } catch {
        // Deleted by flush time — leave mtime unset.
      }
      batch.push(event);
    }
    watch.pending.clear();
    if (batch.length === 0) return;
    try {
      watch.onEvents(batch);
    } catch {
      // Host callback errors must not crash the adapter.
    }
  }

  function recordEvent(watch: ActiveWatch, type: "change" | "rename", relPath: string): void {
    // Drop events that resolve outside the workspace (e.g. via symlink).
    try {
      resolveWithinRoot(relPath);
    } catch {
      return;
    }
    watch.pending.set(relPath, { type, path: relPath });
    if (watch.timer) clearTimeout(watch.timer);
    watch.timer = setTimeout(() => flush(watch), watch.debounceMs);
  }

  function makeListener(
    watch: ActiveWatch,
    watchRel: string,
    isFile: boolean,
  ): (eventType: string, filename: string | Buffer | null) => void {
    return (eventType, filename) => {
      const type: "change" | "rename" = eventType === "rename" ? "rename" : "change";
      let relPath: string;
      if (isFile || filename == null) {
        relPath = watchRel;
      } else {
        relPath = joinRel(watchRel, filename.toString());
      }
      recordEvent(watch, type, relPath);
    };
  }

  function attachOne(
    watch: ActiveWatch,
    absPath: string,
    recursive: boolean,
    listener: (eventType: string, filename: string | Buffer | null) => void,
  ): fs.FSWatcher | null {
    try {
      const w = recursive ? fs.watch(absPath, { recursive: true }, listener) : fs.watch(absPath, listener);
      w.on("error", () => {
        // Ignore late watcher errors (e.g. after close).
      });
      return w;
    } catch {
      return null;
    }
  }

  function attachWatcher(watch: ActiveWatch, absPath: string, watchRel: string, isFile: boolean): void {
    const listener = makeListener(watch, watchRel, isFile);

    if (!isFile) {
      const recursiveWatcher = attachOne(watch, absPath, true, listener);
      if (recursiveWatcher) {
        watch.watchers.push(recursiveWatcher);
        return;
      }
      // Degrade: non-recursive watch of the directory plus one level of children.
      const dirWatcher = attachOne(watch, absPath, false, listener);
      if (dirWatcher) watch.watchers.push(dirWatcher);
      try {
        for (const entry of fs.readdirSync(absPath, { withFileTypes: true })) {
          if (!entry.isDirectory()) continue;
          const childAbs = path.join(absPath, entry.name);
          const childRel = joinRel(watchRel, entry.name);
          const childListener = makeListener(watch, childRel, false);
          const childWatcher = attachOne(watch, childAbs, false, childListener);
          if (childWatcher) watch.watchers.push(childWatcher);
        }
      } catch {
        // Directory may be unreadable or vanish mid-scan.
      }
      return;
    }

    const fileWatcher = attachOne(watch, absPath, false, listener);
    if (fileWatcher) watch.watchers.push(fileWatcher);
  }

  function unwatch(id: string): boolean {
    const watch = watches.get(id);
    if (!watch) return false;
    closeWatchers(watch);
    watches.delete(id);
    return true;
  }

  return {
    async watch(reg: FileWatchRegistration, onEvents): Promise<string> {
      const paths = reg.paths ?? [];
      if (paths.length === 0) {
        throw new Error("watch requires at least one path.");
      }

      // Resolve and reject escapes before touching the filesystem.
      const resolved = paths.map((target) => {
        const abs = resolveWithinRoot(target);
        return { abs, rel: toRel(abs) };
      });

      const id = `watch-${nextId++}`;
      const watch: ActiveWatch = {
        id,
        watchers: [],
        timer: null,
        pending: new Map(),
        debounceMs: reg.debounceMs ?? DEFAULT_DEBOUNCE_MS,
        glob: reg.glob,
        onEvents,
      };
      watches.set(id, watch);

      try {
        for (const { abs, rel } of resolved) {
          const stats = fs.statSync(abs);
          attachWatcher(watch, abs, rel, stats.isFile());
        }
      } catch (err) {
        closeWatchers(watch);
        watches.delete(id);
        throw err;
      }

      return id;
    },

    async unwatch(id: string): Promise<boolean> {
      return unwatch(id);
    },

    async list(): Promise<string[]> {
      return [...watches.keys()];
    },

    async dispose(): Promise<void> {
      for (const id of [...watches.keys()]) {
        unwatch(id);
      }
    },
  };
}
