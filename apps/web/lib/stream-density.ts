'use client';

/**
 * How much of a turn's execution detail the chat feed shows.
 *
 * - `detailed`: every tool call gets its own card (args + output on demand),
 *   reasoning is visible.
 * - `concise`: one line per tool call, reasoning hidden.
 *
 * The value is a user preference stored by the gateway (`preferences`
 * section of `config.json`), like the theme and the UI language: it is a
 * display choice that should follow the user across browsers and machines,
 * not something the transcript carries. The store is therefore the only
 * source — this module holds the type, the default and the hook.
 */

import { useCallback } from 'react';
import { usePreferencesStore } from '@/stores/preferences-store';

export type StreamDensity = 'detailed' | 'concise';

export const DEFAULT_STREAM_DENSITY: StreamDensity = 'detailed';

/** Narrows an arbitrary stored value. */
export function isStreamDensity(value: unknown): value is StreamDensity {
  return value === 'detailed' || value === 'concise';
}

/** Current density plus the setter, shared across every chat surface. */
export function useStreamDensity(): readonly [
  StreamDensity,
  (next: StreamDensity) => void,
] {
  const stored = usePreferencesStore((s) => s.preferences.streamDensity);
  const save = usePreferencesStore((s) => s.save);
  const set = useCallback(
    (next: StreamDensity) => save({ streamDensity: next }),
    [save],
  );
  return [isStreamDensity(stored) ? stored : DEFAULT_STREAM_DENSITY, set] as const;
}
