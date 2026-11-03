/**
 * Model-tier fallback notice (routing tiers, D5).
 *
 * When a sub-agent dispatch references a routing tier that no longer
 * resolves, the SDK degrades the dispatch to the parent model and emits a
 * `subagent_model_tier_unresolved` event on the main feed (parent-level,
 * un-tagged, like F-023's `subagent_permission_downgraded`). This module is
 * the pure event→notice mapping the hook layers on top of the durable event
 * buffer.
 */

import type { ChatNotice } from './projection';

/** On-wire type of the tier-fallback event (spec 2026-10-29 D5). */
const TIER_UNRESOLVED_EVENT = 'subagent_model_tier_unresolved';

/**
 * Projects a `subagent_model_tier_unresolved` frame into the conversation's
 * trailing notice row; `null` for every other frame.
 *
 * The event is emitted loosely through `EventSink`, outside core's
 * `TranscriptEventMap`, so it is read leniently on purpose: only `tierId` is
 * required (the sole field the copy interpolates) and everything else the
 * data may carry — `subagentType`, `turn`, `childSessionId`, the failing
 * `target`, future additions — is ignored, never validated away. A frame
 * without a string `tierId` has no copy to render and maps to `null`.
 */
export function tierNoticeFromEvent(
  event: {
    type: string;
    time: number;
    data: unknown;
  },
  t: (key: string, params?: Record<string, string | number>) => string = (key) => key,
): ChatNotice | null {
  if (event.type !== TIER_UNRESOLVED_EVENT) return null;
  const data = (event.data ?? {}) as { tierId?: unknown; childSessionId?: unknown };
  if (typeof data.tierId !== 'string') return null;

  // `childSessionId` is unique per dispatch; frames without one take the
  // `unknown` slot, where tierId+time keep the key unique in practice.
  const childKey =
    typeof data.childSessionId === 'string' ? data.childSessionId : 'unknown';
  return {
    key: `tier-notice:${data.tierId}:${event.time}:${childKey}`,
    text: t('tier.fallback', { tierId: data.tierId }),
    time: event.time,
  };
}
