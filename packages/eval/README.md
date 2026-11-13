# @voltojs/eval

Deterministic trajectory replay for the pure `step()` reducer — the regression
gate that keeps the core replayable.

Each file in `trajectories/` records one agent session: the `inputs` fed to the
reducer and, per step, its `expected` outcome. Replaying re-feeds the inputs
through `step()` and deep-compares what comes out.

## Strict mode (the CI gate)

```bash
pnpm --filter @voltojs/eval build
pnpm --filter @voltojs/eval replay        # node dist/cli.js
```

Replay is strict by default. Per step it deep-compares:

- `fullEffects` — every effect object (type + payload), in order;
- `fullState` — the whole reducer state, key by key;
- `state` / `effects` — the partial projection and effect type names.

A step recorded without `fullState` cannot be decided strictly; replay reports
that as a failure (exit 1) rather than passing on the partial projection alone.
There is no tolerance, ignore list, or `--loose` in CI: a divergence is either
a stale fixture or a behaviour change that needs to be explained.

## Refreshing fixtures (`--record`)

When a core change is intentional and the fixtures are simply older than it,
refresh them with the recorder instead of hand-editing JSON:

```bash
pnpm --filter @voltojs/eval build
node packages/eval/dist/cli.js --record          # or: pnpm --filter @voltojs/eval exec node dist/cli.js --record
git diff --stat packages/eval/trajectories
pnpm --filter @voltojs/eval replay               # must pass strict, twice to prove determinism
```

`--record` feeds each trajectory's `inputs` through `step()` exactly like replay
does, then rewrites that file's `expected` array with the observed outcomes:
the `state` projection, `fullState` and `fullEffects`, produced by the single
shared mapping in `trajectory.ts` (`toExpectedStep`) that the live recorder also
uses. Everything else in the file — `name`, `stepContext`, `inputs`, `metadata`,
key order — is preserved, and the file keeps its formatting (2-space indent,
trailing newline). It prints one line per file.

`--record` is opt-in only: it is never the default, it cannot be combined with
`--loose`, and CI never runs it. Prefer it over `scripts/generate-fixtures.mjs`
for refreshing checked-in fixtures — the generator regenerates whole files from
its own definitions and drops hand edits.

If running `--record` twice produces different output, a recorded field is
non-deterministic; that is a core purity bug, not a fixture problem — report it
instead of committing the churn.

## CLI

```
node dist/cli.js [--dir <trajectories-dir>] [--loose] [--record] [--help]
```

| Option | Meaning |
| --- | --- |
| `--dir <path>` | directory of `*.json` trajectories (default `packages/eval/trajectories`) |
| `--loose` | legacy partial comparison (status + effect type names); never used by CI |
| `--record` | rewrite each trajectory's `expected` from the observed `(state, effects)` |
| `--help`, `-h` | usage |

Exit codes: `0` all passed / all recorded, `1` at least one trajectory failed
(or could not be recorded), `2` usage or environment error.

## Programmatic API

- `replayTrajectory(trajectory, ctx, { strict })` — compare a trajectory.
- `recordTrajectory(trajectory, ctx)` — produce fresh `expected` entries
  (the record path behind `--record`).
- `simulateTrajectory(name, inputs, ctx)` — record a fixed input sequence.
- `createTrajectoryRecorder()` — live recorder (captures `fullState` /
  `fullEffects` through the same mapping).
- `createSimulation()` — seeded Clock / Id / Random / scripted ModelPort for
  fully offline runs.