'use client';

/**
 * How much of a turn's execution detail the chat feed shows.
 *
 * - `detailed`: every tool call gets its own card (args + output on demand),
 *   reasoning is visible.
 * - `concise`: one line per tool call, reasoning hidden.
 *
 * Browser-local on purpose, like `reasoning-preferences.ts`: this is a
 * display preference, not part of a session's configuration, so it must not
 * travel with the transcript or diverge between a saved session and the
 * current one.
 */

import { useSyncExternalStore } from 'react';

export type StreamDensity = 'detailed' | 'concise';

export const DEFAULT_STREAM_DENSITY: StreamDensity = 'detailed';

const STORAGE_KEY = 'volto.stream-density.v1';

/** Notified after every write so every subscribed component re-reads. */
const listeners = new Set<() => void>();

function isDensity(value: unknown): value is StreamDensity {
  return value === 'detailed' || value === 'concise';
}

/**
 * Reads the stored preference. Anything unparseable or unknown falls back to
 * the default rather than throwing — a hand-edited or stale value must not
 * break rendering.
 */
export function readStreamDensity(): StreamDensity {
  if (typeof window === 'undefined') return DEFAULT_STREAM_DENSITY;
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    return isDensity(raw) ? raw : DEFAULT_STREAM_DENSITY;
  } catch {
    return DEFAULT_STREAM_DENSITY;
  }
}

/** Records an explicit choice. Storage failures (private mode, quota) are ignored. */
export function writeStreamDensity(next: StreamDensity): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(STORAGE_KEY, next);
  } catch {
    // A preference that cannot be saved is not worth failing a render over.
  }
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Current density plus the setter, shared across every chat surface. */
export function useStreamDensity(): readonly [StreamDensity, (next: StreamDensity) => void] {
  const density = useSyncExternalStore(
    subscribe,
    readStreamDensity,
    () => DEFAULT_STREAM_DENSITY,
  );
  return [density, writeStreamDensity] as const;
}
