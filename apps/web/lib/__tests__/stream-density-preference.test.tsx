import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { DEFAULT_STREAM_DENSITY, useStreamDensity } from '../stream-density';
import { usePreferencesStore } from '@/stores/preferences-store';

describe('stream density preference', () => {
  beforeEach(() => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({}), { status: 200 }),
    );
    usePreferencesStore.setState({ preferences: {}, loaded: true });
  });

  it('defaults to detailed when the gateway stores nothing', () => {
    const { result } = renderHook(() => useStreamDensity());
    expect(result.current[0]).toBe(DEFAULT_STREAM_DENSITY);
  });

  it('reads the stored value and writes the next one back', () => {
    usePreferencesStore.setState({ preferences: { streamDensity: 'concise' }, loaded: true });
    const { result } = renderHook(() => useStreamDensity());
    expect(result.current[0]).toBe('concise');

    act(() => result.current[1]('detailed'));
    expect(usePreferencesStore.getState().preferences.streamDensity).toBe('detailed');
  });
});
