import type {
  TaggedTranscriptDelta,
  TranscriptEventInput,
} from '@voltojs/sdk/sse';

/** Bucket key for tagged events that arrive without a childSessionId. */
export const UNTAGGED_BUCKET = '_';

function childIdOf(tags: {
  agentDepth?: unknown;
  childSessionId?: unknown;
}): string | null {
  if (typeof tags.agentDepth !== 'number' || tags.agentDepth <= 0) return null;
  return typeof tags.childSessionId === 'string'
    ? tags.childSessionId
    : UNTAGGED_BUCKET;
}

/** null = main-conversation traffic; a string = sub-agent bucket key. */
export function eventChildId(event: TranscriptEventInput): string | null {
  return childIdOf(event.data as { agentDepth?: unknown; childSessionId?: unknown });
}

export function deltaChildId(delta: TaggedTranscriptDelta): string | null {
  return childIdOf(delta as { agentDepth?: unknown; childSessionId?: unknown });
}
