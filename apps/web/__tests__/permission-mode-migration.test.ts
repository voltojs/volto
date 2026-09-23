import { describe, it, expect } from 'vitest';
import { normalisePermissionMode } from '@/hooks/use-server-sessions';

describe('normalisePermissionMode', () => {
  it('passes the four current presets through', () => {
    expect(normalisePermissionMode('read-only')).toBe('read-only');
    expect(normalisePermissionMode('ask')).toBe('ask');
    expect(normalisePermissionMode('auto')).toBe('auto');
    expect(normalisePermissionMode('full')).toBe('full');
  });

  it('migrates the retired names stored in old transcripts', () => {
    expect(normalisePermissionMode('auto-accept')).toBe('auto');
  });

  it('reads plan back as itself, like the gateway twin', () => {
    // `plan` is a first-class preset (server normaliseUiPermissionMode keeps
    // it: "persisted plan reads back as itself"). Mapping it to read-only on
    // the web read path silently downgraded the badge of every plan session
    // reloaded from the server — the UI showed read-only while the gateway
    // still ran plan.
    expect(normalisePermissionMode('plan')).toBe('plan');
  });

  it('falls back to ask rather than to the widest tier', () => {
    expect(normalisePermissionMode(null)).toBe('ask');
    expect(normalisePermissionMode('nonsense')).toBe('ask');
  });

  it('falls back to ask for Object.prototype member names', () => {
    // A bare index into the plain legacy map would resolve `constructor`,
    // `toString`, `__proto__`, and `hasOwnProperty` through the prototype
    // chain and return something other than 'ask'. The function must use
    // Object.hasOwn, never a naked index.
    const inherited: string[] = [
      'constructor',
      'toString',
      '__proto__',
      'hasOwnProperty',
    ];
    for (const mode of inherited) {
      expect(normalisePermissionMode(mode)).toBe('ask');
    }
  });
});
