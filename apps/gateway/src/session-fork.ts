/**
 * Session fork — copy a completed turn prefix into a new chat session.
 *
 * The source transcript is append-only; a fork copies the event prefix up to
 * a completed `turn_end`, rewrites the first `session_meta`, and copies the
 * attachments (and plan) the prefix references. No agent state or checkpoint
 * is copied: the new session is a fresh conversation seeded from the prefix.
 */

import { collectAttachmentIds } from "@voltojs/core";
import type {
  AttachmentStore,
  PlanStore,
  TranscriptEvent,
  TranscriptEventInput,
} from "@voltojs/core";
import type { ChatSessionRecord, JsonlSessionStore } from "@voltojs/stores/jsonl";
import { DEFAULT_LOCALE, isLocale, t, type Locale } from "@voltojs/sdk/i18n";

export interface ForkOptions {
  /** Copy through the last completed turn at or before this event seq. */
  throughSeq?: number;
  /** Copy exactly this completed turn (1-based). */
  throughTurn?: number;
  /** New title; defaults to the source title plus the branch marker. */
  title?: string;
  /** Locale for the branch marker; the caller's UI language. */
  locale?: Locale;
}

export interface ForkDependencies {
  chatStore: JsonlSessionStore;
  attachmentStoreFor: (sessionId: string) => AttachmentStore;
  planStore: PlanStore;
  /** Workspace the new session file should live under; null = unbound. */
  projectPath: string | null;
  /** New session id, supplied by the host (crypto.randomUUID). */
  newId: string;
}

export interface ForkResult {
  id: string;
  title: string;
  /** Marker appended to the title, as a stable token the UI can re-render. */
  titleSuffix: "branch";
  parentSessionId: string;
}

/** A fork request the host should answer with the carried HTTP status. */
export class ForkError extends Error {
  constructor(
    message: string,
    readonly status: number = 400,
  ) {
    super(message);
    this.name = "ForkError";
  }
}

/** Last index satisfying `pred`, or -1 (ES2022 has no findLastIndex). */
function lastIndexWhere<T>(items: readonly T[], pred: (item: T) => boolean): number {
  for (let i = items.length - 1; i >= 0; i -= 1) {
    const item = items[i];
    if (item !== undefined && pred(item)) return i;
  }
  return -1;
}

/** Index of the last completed `turn_end` selected by the fork cut. */
function resolveCut(events: readonly TranscriptEvent[], opts: ForkOptions): number {
  if (opts.throughSeq !== undefined && opts.throughTurn !== undefined) {
    throw new ForkError("throughSeq and throughTurn are mutually exclusive");
  }

  const requestedTurn = opts.throughTurn;
  if (requestedTurn !== undefined) {
    if (!Number.isInteger(requestedTurn) || requestedTurn < 1) {
      throw new ForkError("throughTurn must be a positive integer");
    }
    const exact = lastIndexWhere(
      events,
      (event) => event.type === "turn_end" && event.turn === requestedTurn,
    );
    if (exact !== -1) return exact;
    // The requested turn never completed (the session was killed mid-turn):
    // back up to the last completed turn before it, per spec D3 — the same
    // fallback throughSeq already applies. Only when nothing at all
    // completed is the cut invalid.
    const fallback = lastIndexWhere(
      events,
      (event) =>
        event.type === "turn_end" &&
        event.turn !== undefined &&
        event.turn < requestedTurn,
    );
    if (fallback === -1) {
      throw new ForkError(`No completed turn ${requestedTurn} or earlier`);
    }
    return fallback;
  }

  if (opts.throughSeq !== undefined) {
    if (!Number.isInteger(opts.throughSeq) || opts.throughSeq < 0) {
      throw new ForkError("throughSeq must be a non-negative integer");
    }
    const at = lastIndexWhere(
      events,
      (event) => event.type === "turn_end" && event.seq <= opts.throughSeq!,
    );
    if (at === -1) throw new ForkError("No completed turn at or before throughSeq");
    return at;
  }

  const at = lastIndexWhere(events, (event) => event.type === "turn_end");
  if (at === -1) throw new ForkError("The session has no completed turn to fork");
  return at;
}

/**
 * Rewrite every session_meta inside the prefix for the new branch. A rename
 * appends its own meta event and the store merges metas last-wins, so
 * rewriting only the first one would let a later meta restore the source
 * title (losing the branch marker) or re-introduce origin: "subagent".
 */
function rewriteMeta(
  prefix: TranscriptEventInput[],
  source: ChatSessionRecord,
  title: string,
): void {
  const branchData = (base: Record<string, unknown> | undefined): Record<string, unknown> => {
    const meta: Record<string, unknown> = {
      ...(base ?? (source.meta as unknown as Record<string, unknown>)),
      title,
      parentSessionId: source.sessionId,
    };
    delete meta["origin"];
    return meta;
  };

  let sawMeta = false;
  for (let i = 0; i < prefix.length; i += 1) {
    const event = prefix[i]!;
    if (event.type !== "session_meta") continue;
    sawMeta = true;
    prefix[i] = {
      time: event.time,
      type: "session_meta",
      data: branchData(event.data as Record<string, unknown>) as never,
    };
  }
  if (!sawMeta) {
    const first = prefix[0];
    prefix.unshift({
      time: first?.time ?? Date.now(),
      type: "session_meta",
      data: branchData(undefined) as never,
    });
  }
}

/** Copy bytes for every ref the prefix uses; missing refs degrade to a warning. */
async function copyAttachments(
  ids: readonly string[],
  sourceStore: AttachmentStore,
  targetStore: AttachmentStore,
): Promise<void> {
  for (const id of ids) {
    const found = await sourceStore.get(id).catch(() => undefined);
    if (found === undefined) {
      console.warn(`fork: attachment ${id} is missing from the source session`);
      continue;
    }
    // A failed copy degrades like a missing attachment: the branch is
    // already durable by this point, and failing the request would leave
    // an orphaned-but-listed session behind that a retry would duplicate.
    try {
      await targetStore.put(found.data, found.mimeType, {
        id,
        ...(found.name !== undefined ? { name: found.name } : {}),
      });
    } catch (err: unknown) {
      console.warn(
        `fork: attachment ${id} copy failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
}

export async function forkSession(
  source: ChatSessionRecord,
  opts: ForkOptions,
  deps: ForkDependencies,
): Promise<ForkResult> {
  // A pre-existing target id would make the store's write path resolve to
  // that session's file and APPEND the prefix onto its tail, corrupting it —
  // refuse instead. The generated UUID never hits this in practice; it
  // guards direct callers.
  if (await deps.chatStore.readSession(deps.newId)) {
    throw new ForkError(`Target session ${deps.newId} already exists`, 500);
  }
  const cut = resolveCut(source.events, opts);
  const prefix = source.events
    .slice(0, cut + 1)
    .map((event): TranscriptEventInput => ({
      time: event.time,
      type: event.type,
      data: event.data,
      ...(event.turn !== undefined ? { turn: event.turn } : {}),
      ...(event.step !== undefined ? { step: event.step } : {}),
    }));

  const baseTitle = source.meta.title ?? "";
  const locale = isLocale(opts.locale) ? opts.locale : DEFAULT_LOCALE;
  const title =
    opts.title ??
    (baseTitle === ""
      ? t(locale, "server.fork.branchName")
      : `${baseTitle}${t(locale, "server.fork.branchSuffix")}`);
  rewriteMeta(prefix, source, title);

  await deps.chatStore.appendEvents(deps.projectPath, deps.newId, prefix);

  const attachmentIds = collectAttachmentIds(prefix as unknown as TranscriptEvent[]);
  if (attachmentIds.length > 0) {
    await copyAttachments(
      attachmentIds,
      deps.attachmentStoreFor(source.sessionId),
      deps.attachmentStoreFor(deps.newId),
    );
  }

  if (deps.projectPath !== null) {
    try {
      const plan = await deps.planStore.read(source.sessionId, deps.projectPath);
      if (plan !== null) await deps.planStore.save(deps.newId, deps.projectPath, plan);
    } catch (err: unknown) {
      console.warn(
        `fork: plan copy skipped: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  return { id: deps.newId, title, titleSuffix: "branch", parentSessionId: source.sessionId };
}
