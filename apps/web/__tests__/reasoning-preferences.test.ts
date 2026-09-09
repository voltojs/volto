/**
 * @vitest-environment jsdom
 *
 * The remembered reasoning-effort choice. The load-bearing rule is that a
 * remembered value is validated against the model's currently declared
 * efforts before being handed back — an unsupported effort is rejected by
 * the gateway at send time, so it must never survive a model's tiers
 * changing.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
  rememberEffort,
  rememberedEffort,
} from '../lib/reasoning-preferences.js';

const EFFORTS = [{ id: 'low' }, { id: 'high' }];

beforeEach(() => {
  window.localStorage.clear();
});

describe('reasoning-effort preferences', () => {
  it('returns a remembered choice for the same model', () => {
    rememberEffort('v1', 'm1', 'high');
    expect(rememberedEffort('v1', 'm1', EFFORTS)).toBe('high');
  });

  it('keeps choices per model rather than as one global tier', () => {
    rememberEffort('v1', 'm1', 'high');
    rememberEffort('v1', 'm2', 'low');
    expect(rememberedEffort('v1', 'm1', EFFORTS)).toBe('high');
    expect(rememberedEffort('v1', 'm2', EFFORTS)).toBe('low');
    // A model never chosen for has no remembered value — not a borrowed one.
    expect(rememberedEffort('v1', 'm3', EFFORTS)).toBeUndefined();
    expect(rememberedEffort('v2', 'm1', EFFORTS)).toBeUndefined();
  });

  it('drops a remembered effort the model no longer declares', () => {
    rememberEffort('v1', 'm1', 'high');
    expect(rememberedEffort('v1', 'm1', [{ id: 'low' }])).toBeUndefined();
    // ...including when the model lost its reasoning capability entirely.
    expect(rememberedEffort('v1', 'm1', [])).toBeUndefined();
  });

  it('clears the entry when the effort is cleared', () => {
    rememberEffort('v1', 'm1', 'high');
    rememberEffort('v1', 'm1', undefined);
    expect(rememberedEffort('v1', 'm1', EFFORTS)).toBeUndefined();
  });

  it('survives a corrupt or hand-edited store instead of throwing', () => {
    window.localStorage.setItem('volto.reasoning-effort.v1', 'not json');
    expect(rememberedEffort('v1', 'm1', EFFORTS)).toBeUndefined();
    // ...and a write still repairs it.
    rememberEffort('v1', 'm1', 'low');
    expect(rememberedEffort('v1', 'm1', EFFORTS)).toBe('low');

    window.localStorage.setItem('volto.reasoning-effort.v1', '{"v1:m1":42}');
    expect(rememberedEffort('v1', 'm1', EFFORTS)).toBeUndefined();
  });

  it('is a no-op without a provider/model reference', () => {
    rememberEffort(null, 'm1', 'high');
    rememberEffort('v1', null, 'high');
    expect(rememberedEffort(null, null, EFFORTS)).toBeUndefined();
    expect(window.localStorage.getItem('volto.reasoning-effort.v1')).toBeNull();
  });
});
