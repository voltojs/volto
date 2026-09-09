/**
 * Remembered reasoning-effort choice, per model.
 *
 * Keyed by model rather than stored as one global tier: the set of efforts
 * belongs to one exact model (a "high" chosen for one model may not exist on
 * the next), so a single remembered value would either be dropped constantly
 * or, worse, silently substituted. Nothing here interprets an effort id —
 * they are opaque strings the server declares.
 *
 * Browser-local on purpose. This is a UI preference, not part of a session's
 * configuration: what a turn actually ran with lives in the session's own
 * `reasoningEffort` (and in its transcript), and that stays the source of
 * truth for anything already sent.
 */

const STORAGE_KEY = 'volto.reasoning-effort.v1';

type Preferences = Record<string, string>;

/** `providerId` is volto's own config id, so a deleted+recreated provider simply forgets. */
function keyOf(providerId: string, modelId: string): string {
  return `${providerId}:${modelId}`;
}

function read(): Preferences {
  // Reads are cheap and this is called during render; going to localStorage
  // each time (rather than caching) keeps two tabs from disagreeing.
  if (typeof window === 'undefined') return {};
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    // Anything but a flat string map is treated as absent rather than
    // throwing — a corrupt or hand-edited entry must not break the picker.
    if (typeof parsed !== 'object' || parsed === null) return {};
    return Object.fromEntries(
      Object.entries(parsed as Record<string, unknown>).filter(
        (entry): entry is [string, string] => typeof entry[1] === 'string',
      ),
    );
  } catch {
    return {};
  }
}

/**
 * The effort last chosen for this model, if it is still one the model
 * declares. `efforts` is required precisely so a stale value (the model's
 * tiers changed, or the provider was reconfigured) can never be returned:
 * an unsupported effort would be rejected by the gateway at send time.
 */
export function rememberedEffort(
  providerId: string | null,
  modelId: string | null,
  efforts: ReadonlyArray<{ id: string }>,
): string | undefined {
  if (!providerId || !modelId) return undefined;
  const stored = read()[keyOf(providerId, modelId)];
  if (stored === undefined) return undefined;
  return efforts.some((e) => e.id === stored) ? stored : undefined;
}

/** Records an explicit user choice. Storage failures (private mode, quota) are ignored. */
export function rememberEffort(
  providerId: string | null,
  modelId: string | null,
  effort: string | undefined,
): void {
  if (typeof window === 'undefined' || !providerId || !modelId) return;
  const next = read();
  if (effort === undefined) {
    delete next[keyOf(providerId, modelId)];
  } else {
    next[keyOf(providerId, modelId)] = effort;
  }
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
  } catch {
    // A preference that cannot be saved is not worth failing a turn over.
  }
}
