/**
 * Failed-authentication rate limiting (R29).
 *
 * The gateway exposes a machine's filesystem and an arbitrary-command agent
 * behind one token. A single unauthenticated loop guessing that token must
 * not own the CPU, and — just as important — one scanner must not be able to
 * lock the operator out. Both constraints are structural here:
 *
 * - **Per IP, never global.** Each key keeps its own failures and cooldown.
 * - **Only failures count.** A success clears the key's history outright, so
 *   the operator presenting a valid credential always gets through, even
 *   from an address that is currently cooling down.
 * - **Bounded memory.** A flood of distinct source addresses must not grow
 *   the map without limit; expired keys are pruned and the map is capped,
 *   dropping the least recently seen key first (which can only ever HELP an
 *   attacker, never block someone who was not already blocked).
 * - **Injectable clock.** `now` is the only source of time, so the window and
 *   the cooldown are tested without sleeping.
 */

export interface AuthRateLimiterOptions {
  /** Failures allowed inside `windowMs` before the cooldown starts. @default 10 */
  limit?: number;
  /** Sliding window for counting failures, in ms. @default 60000 */
  windowMs?: number;
  /** How long a tripped key is refused, in ms. @default 60000 */
  cooldownMs?: number;
  /** Clock, in ms. Defaults to `Date.now`; tests inject a counter. */
  now?: () => number;
  /** Cap on tracked keys. @default 10000 */
  maxEntries?: number;
}

export interface AuthRateLimiter {
  /** Whether `ip` may attempt authentication now, plus the wait if not. */
  check(ip: string): { allowed: boolean; retryAfterMs: number };
  /** Count one failed attempt. Trips the cooldown at the limit. */
  recordFailure(ip: string): void;
  /** Clear everything known about `ip`. */
  recordSuccess(ip: string): void;
  /** Number of tracked keys — for tests and diagnostics. */
  size(): number;
}

interface Entry {
  /** Timestamps of the failures still inside the window, oldest first. */
  failures: number[];
  /** End of the cooldown; 0 when not cooling down. */
  blockedUntil: number;
  /** Last time this key was touched — the eviction order under the cap. */
  seenAt: number;
}

const DEFAULT_LIMIT = 10;
const DEFAULT_WINDOW_MS = 60_000;
const DEFAULT_COOLDOWN_MS = 60_000;
const DEFAULT_MAX_ENTRIES = 10_000;
/**
 * How often the full sweep runs, in touches, when the cap is not reached.
 * A full sweep costs O(keys), so it must stay rare even though every touch
 * may be a new key — but not so rare that dead keys linger for long on a
 * gateway seeing a steady trickle of scans.
 */
const SWEEP_EVERY = 64;

export function createAuthRateLimiter(opts: AuthRateLimiterOptions = {}): AuthRateLimiter {
  const limit = opts.limit ?? DEFAULT_LIMIT;
  const windowMs = opts.windowMs ?? DEFAULT_WINDOW_MS;
  const cooldownMs = opts.cooldownMs ?? DEFAULT_COOLDOWN_MS;
  const now = opts.now ?? (() => Date.now());
  const maxEntries = opts.maxEntries ?? DEFAULT_MAX_ENTRIES;

  const entries = new Map<string, Entry>();
  let touches = 0;
  let lastSweepAt = Number.NEGATIVE_INFINITY;

  /** A key is dead once its window drained AND its cooldown ended. */
  function isExpired(entry: Entry, at: number): boolean {
    if (entry.blockedUntil > at) return false;
    const last = entry.failures[entry.failures.length - 1];
    return last === undefined || last + windowMs <= at;
  }

  function release(ip: string): void {
    entries.delete(ip);
  }

  /** Drop the least recently seen key when the cap is reached. */
  function evictOne(): void {
    let oldestKey: string | undefined;
    let oldestSeen = Number.POSITIVE_INFINITY;
    for (const [key, entry] of entries) {
      if (entry.seenAt < oldestSeen) {
        oldestSeen = entry.seenAt;
        oldestKey = key;
      }
    }
    if (oldestKey !== undefined) entries.delete(oldestKey);
  }

  /** Prune expired keys, then enforce the cap. */
  function maintain(at: number): void {
    touches = 0;
    lastSweepAt = at;
    for (const [key, entry] of entries) {
      if (isExpired(entry, at)) entries.delete(key);
    }
    while (entries.size >= maxEntries) evictOne();
  }

  /**
   * Before inserting a new key: sweep on a schedule, or at the cap. A sweep is
   * also due once the clock has moved on, because that is exactly when the
   * keys already held are candidates for expiry.
   */
  function touch(at: number): void {
    touches += 1;
    if (touches >= SWEEP_EVERY || entries.size >= maxEntries || at > lastSweepAt) maintain(at);
  }

  return {
    check(ip) {
      const at = now();
      const entry = entries.get(ip);
      if (entry === undefined) return { allowed: true, retryAfterMs: 0 };
      if (isExpired(entry, at)) {
        release(ip);
        return { allowed: true, retryAfterMs: 0 };
      }
      if (entry.blockedUntil > at) {
        return { allowed: false, retryAfterMs: entry.blockedUntil - at };
      }
      return { allowed: true, retryAfterMs: 0 };
    },

    recordFailure(ip) {
      const at = now();
      let entry = entries.get(ip);
      if (entry === undefined) {
        touch(at);
        entry = { failures: [], blockedUntil: 0, seenAt: at };
        entries.set(ip, entry);
      }
      entry.seenAt = at;
      // Drop everything that aged out of the sliding window.
      const cutoff = at - windowMs;
      while (entry.failures.length > 0 && entry.failures[0]! <= cutoff) entry.failures.shift();
      entry.failures.push(at);
      if (entry.failures.length >= limit) {
        // The cooldown starts at the failure that tripped the limit.
        entry.blockedUntil = at + cooldownMs;
        entry.failures = [];
      }
    },

    recordSuccess(ip) {
      // A success is proof the caller holds a valid credential: forgetting the
      // history is what keeps a noisy neighbour from locking the operator out.
      release(ip);
    },

    size() {
      return entries.size;
    },
  };
}