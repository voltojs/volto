/** The permission tiers a session can run in. Order is the picker's order. */
export const PERMISSION_MODES = ['read-only', 'plan', 'ask', 'auto', 'full'] as const;

/** Narrows an arbitrary string (config file, server payload) to a tier. */
export function isPermissionMode(value: unknown): value is (typeof PERMISSION_MODES)[number] {
  return typeof value === 'string' && (PERMISSION_MODES as readonly string[]).includes(value);
}
