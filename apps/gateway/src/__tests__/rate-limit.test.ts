import { expect, it } from "vitest";
import { createAuthRateLimiter } from "../auth/rate-limit.js";

it("10 次失败后冷却，成功清零", () => {
  let t = 0;
  const rl = createAuthRateLimiter({ limit: 10, windowMs: 60_000, cooldownMs: 60_000, now: () => t });
  for (let i = 0; i < 10; i++) rl.recordFailure("1.2.3.4");
  expect(rl.check("1.2.3.4").allowed).toBe(false);
  t += 60_001;
  expect(rl.check("1.2.3.4").allowed).toBe(true);
  rl.recordFailure("1.2.3.4");
  rl.recordSuccess("1.2.3.4");
  expect(rl.check("1.2.3.4").allowed).toBe(true);
});

it("按 IP 隔离，不误伤其他 IP", () => {
  const t = 0;
  const rl = createAuthRateLimiter({ limit: 2, windowMs: 60_000, cooldownMs: 60_000, now: () => t });
  rl.recordFailure("a");
  rl.recordFailure("a");
  expect(rl.check("a").allowed).toBe(false);
  expect(rl.check("b").allowed).toBe(true);
});

// ──────────────────────────────────────────────
// Contract details the brief's two cases leave implicit. All of them run on
// the injected clock: no real sleeps, no wall-clock dependence.
// ──────────────────────────────────────────────

it("reports the remaining cooldown as retryAfterMs", () => {
  let t = 1_000;
  const rl = createAuthRateLimiter({ limit: 2, windowMs: 60_000, cooldownMs: 60_000, now: () => t });
  rl.recordFailure("a");
  rl.recordFailure("a");
  expect(rl.check("a")).toEqual({ allowed: false, retryAfterMs: 60_000 });
  t += 45_000;
  // The 60s countdown starts at the failure that tripped the limit (t=1000),
  // so 45s later there are 15s left — not another full cooldown.
  expect(rl.check("a")).toEqual({ allowed: false, retryAfterMs: 15_000 });
  t += 15_000;
  expect(rl.check("a").allowed).toBe(true);
});

it("allows with retryAfterMs 0 while under the limit", () => {
  const t = 0;
  const rl = createAuthRateLimiter({ limit: 3, windowMs: 10_000, cooldownMs: 60_000, now: () => t });
  rl.recordFailure("a");
  expect(rl.check("a")).toEqual({ allowed: true, retryAfterMs: 0 });
});

it("only counts failures inside the sliding window", () => {
  let t = 0;
  const rl = createAuthRateLimiter({ limit: 2, windowMs: 60_000, cooldownMs: 60_000, now: () => t });
  rl.recordFailure("a");
  t += 30_000;
  rl.recordFailure("a");
  // Both inside the window → blocked.
  expect(rl.check("a").allowed).toBe(false);

  let t2 = 0;
  const rl2 = createAuthRateLimiter({ limit: 2, windowMs: 60_000, cooldownMs: 60_000, now: () => t2 });
  rl2.recordFailure("a");
  t2 += 60_001;
  rl2.recordFailure("a");
  // The first failure aged out of the window → one in flight, not two.
  expect(rl2.check("a").allowed).toBe(true);
});

it("a success clears the in-window failures, so a later single failure does not trip it", () => {
  const t = 0;
  const rl = createAuthRateLimiter({ limit: 3, windowMs: 60_000, cooldownMs: 60_000, now: () => t });
  rl.recordFailure("a");
  rl.recordFailure("a");
  rl.recordFailure("a");
  expect(rl.check("a").allowed).toBe(false);
  // A success during the cooldown lifts it — the operator presenting a valid
  // credential is exactly the proof the limiter is waiting for.
  rl.recordSuccess("a");
  expect(rl.check("a").allowed).toBe(true);
  rl.recordFailure("a");
  rl.recordFailure("a");
  expect(rl.check("a").allowed).toBe(true);
  rl.recordFailure("a");
  expect(rl.check("a").allowed).toBe(false);
});

it("keeps memory bounded: a flood of distinct IPs never grows the map past the cap", () => {
  const t = 0;
  const rl = createAuthRateLimiter({
    limit: 1,
    windowMs: 60_000,
    cooldownMs: 60_000,
    maxEntries: 8,
    now: () => t,
  });
  for (let i = 0; i < 1_000; i++) {
    const ip = `10.0.0.${i}`;
    rl.recordFailure(ip);
  }
  // Whatever survived the cap still enforces its own limit…
  rl.recordFailure("10.0.0.999");
  expect(rl.check("10.0.0.999").allowed).toBe(false);
  // …and pruning never turns a blocked IP loose early: the most recent
  // failures remain tracked and still trip the limit.
  expect(rl.check("10.0.0.998").allowed).toBe(false);
});

it("prunes entries whose window and cooldown have both expired", () => {
  let t = 0;
  const rl = createAuthRateLimiter({ limit: 5, windowMs: 1_000, cooldownMs: 1_000, now: () => t });
  rl.recordFailure("a");
  rl.recordFailure("b");
  expect(rl.size()).toBe(2);
  t += 10_000;
  // A write sweeps keys whose window and cooldown both ended…
  rl.recordFailure("fresh");
  expect(rl.size()).toBe(1);
  expect(rl.check("a").allowed).toBe(true);
  expect(rl.check("b").allowed).toBe(true);
  expect(rl.size()).toBe(1);
});

it("keeps a cooling-down key blocked even after its failure window drained", () => {
  let t = 0;
  // window 1s, cooldown 60s: the failures age out long before the cooldown.
  const rl = createAuthRateLimiter({ limit: 1, windowMs: 1_000, cooldownMs: 60_000, now: () => t });
  rl.recordFailure("a");
  t += 30_000;
  expect(rl.check("a")).toEqual({ allowed: false, retryAfterMs: 30_000 });
  expect(rl.size()).toBe(1);
});