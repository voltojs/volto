/**
 * Session fork — copy a completed turn prefix into a new chat session.
 *
 * The source transcript is append-only; a fork copies the event prefix up to
 * a completed `turn_end`, rewrites the first `session_meta`, and copies the
 * attachments (and plan) the prefix references. No agent state or checkpoint
 * is copied: the new session is a fresh conversation seeded from the prefix.
 */

import { collectAttachmentIds } from "@volto/core";
import type {
  AttachmentStore,
  PlanStore,
  TranscriptEvent,
  TranscriptEventInput,
} from "@volto/core";
import type { ChatSessionRecord, JsonlSessionStore } from "@volto/store-jsonl";

export interface ForkOptions {
  /** Copy through the last completed turn at or before this event seq. */
  throughSeq?: number;
  /** Copy exactly this completed turn (1-based). */
  throughTurn?: number;
  /** New title; defaults to `<source title>（分支）`. */
  title?: string;
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

  if (opts.throughTurn !== undefined) {
    if (!Number.isInteger(opts.throughTurn) || opts.throughTurn < 1) {
      throw new ForkError("throughTurn must be a positive integer");
    }
    const at = lastIndexWhere(
      events,
      (event) => event.type === "turn_end" && event.turn === opts.throughTurn,
    );
    if (at === -1) throw new ForkError(`No completed turn ${opts.throughTurn}`);
    return at;
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

/** Rewrite the first session_meta for the new branch. */
function rewriteMeta(
  prefix: TranscriptEventInput[],
  source: ChatSessionRecord,
  title: string,
): void {
  const first = prefix[0];
  const firstData =
    first?.type === "session_meta"
      ? (first.data as Record<string, unknown>)
      : (source.meta as unknown as Record<string, unknown>);
  const meta: Record<string, unknown> = {
    ...firstData,
    title,
    parentSessionId: source.sessionId,
  };
  delete meta["origin"];
  const metaEvent: TranscriptEventInput = {
    time: first?.time ?? Date.now(),
    type: "session_meta",
    data: meta as never,
  };
  if (first?.type === "session_meta") prefix[0] = metaEvent;
  else prefix.unshift(metaEvent);
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
    await targetStore.put(found.data, found.mimeType, {
      id,
      ...(found.name !== undefined ? { name: found.name } : {}),
    });
  }
}

export async function forkSession(
  source: ChatSessionRecord,
  opts: ForkOptions,
  deps: ForkDependencies,
): Promise<ForkResult> {
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
  const title = opts.title ?? (baseTitle === "" ? "分支" : `${baseTitle}（分支）`);
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

  return { id: deps.newId, title, parentSessionId: source.sessionId };
}
