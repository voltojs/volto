/**
 * Context-usage projection for one sub-agent session: disk snapshot (subagent
 * cache, filled by use-subagent-conversation) plus the live parent-channel
 * bucket, folded with the same heuristic tokenizer as the main meter.
 * No server seed — child sessions are excluded from GET /sessions, so usage
 * starts unanchored and relies on usage-bearing events in the transcript.
 */

import { useMemo } from 'react';
import { useChatStore } from '@/stores/chat-store';
import { getCachedSubagentEvents } from '@/lib/subagent-cache';
import { projectContextUsage } from '@/lib/context-usage';
import type { ContextUsageView, TranscriptEventInput } from '@voltojs/sdk/sse';

/**
 * Stored + live events without double-folding the same logical event. Disk
 * and the live bucket often carry the same frames during a run (persisted
 * and tagged-copy); key by time+type which is unique per server stamp.
 */
function mergeUsageEvents(
  stored: readonly TranscriptEventInput[] | undefined,
  live: readonly TranscriptEventInput[] | undefined,
): TranscriptEventInput[] {
  if (!stored?.length) return live ? [...live] : [];
  if (!live?.length) return [...stored];
  const seen = new Set<string>();
  const out: TranscriptEventInput[] = [];
  for (const e of [...stored, ...live]) {
    const key = `${e.time}|${e.type}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(e);
  }
  return out;
}

export function useSubagentContextUsage(
  childSessionId: string | null,
): ContextUsageView | null {
  const bucket = useChatStore((s) =>
    childSessionId ? s.subagents[childSessionId] : undefined,
  );

  return useMemo(() => {
    if (!childSessionId) return null;
    const stored = getCachedSubagentEvents(childSessionId);
    const live = bucket?.events;
    const events = mergeUsageEvents(stored, live);
    if (events.length === 0) return null;
    return projectContextUsage(null, events, true).view;
  }, [childSessionId, bucket]);
}
