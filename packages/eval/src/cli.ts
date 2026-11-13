#!/usr/bin/env node
/**
 * volto-eval-replay — deterministic trajectory regression runner (CI gate).
 *
 * Scans `*.json` trajectory files in a directory, replays each through the
 * pure step() reducer (strict mode by default: full (state, effects)
 * consistency), prints a per-trajectory report and exits non-zero on any
 * failure — the M11 "重放式 eval" acceptance as a CI check.
 *
 * `--record` (opt-in, never the default) turns the same run into a fixture
 * refresh: each trajectory's `inputs` are re-fed through step() exactly like
 * replay, and its `expected` array is rewritten with the freshly observed
 * outcomes — the partial `state` projection, `fullState` and `fullEffects`,
 * all produced by the shared `toExpectedStep` mapping in trajectory.ts (the
 * one the recorder uses). Everything else in the file (name, stepContext,
 * inputs, metadata, key order) is preserved and the file is written back with
 * the existing formatting (2-space indent, trailing newline). Run it after an
 * intentional core change, then serve the diff to `replay` with no flags.
 *
 * Usage:
 *   node dist/cli.js [--dir <trajectories-dir>] [--loose] [--record] [--help]
 *
 * README: README.md (usage + strict mode + --record).
 */

import { readdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { replayTrajectory, recordTrajectory } from "./replay.js";
import type { Trajectory } from "./trajectory.js";
import type { StepContext } from "@voltojs/core";

const THIS_DIR = dirname(fileURLToPath(import.meta.url));

const HELP = `volto-eval-replay — trajectory regression runner

Usage: node dist/cli.js [--dir <trajectories-dir>] [--loose] [--record] [--help]

Options:
  --dir <path>   directory of trajectory JSON files
                 (default: <package>/trajectories)
  --loose        legacy partial comparison (status + effect type names)
  --record       re-feed each trajectory's inputs through step() and rewrite
                 its "expected" array with the observed state / fullState /
                 fullEffects; all other fields and the JSON formatting are
                 preserved. Not a gate: never the default, never used by CI.
  --help, -h     show this help

Exit codes:
  0  all trajectories passed (or, with --record, all were recorded)
  1  at least one trajectory failed (a trajectory has no expected.fullState
     to deep-compare, or, with --record, could not be recorded)
  2  usage / environment error (missing dir or no trajectory files)
`;

interface Options {
  dir: string;
  strict: boolean;
  record: boolean;
}

function parseArgs(argv: string[]): Options {
  let dir = resolve(THIS_DIR, "../trajectories");
  let strict = true;
  let record = false;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if ((arg === "--dir" || arg === "-d") && argv[i + 1]) {
      dir = resolve(argv[i + 1]!);
      i++;
    } else if (arg === "--loose") {
      strict = false;
    } else if (arg === "--record") {
      record = true;
    } else if (arg === "--help" || arg === "-h") {
      console.log(HELP);
      process.exit(0);
    } else {
      console.error(`Unknown argument: ${arg}\n\n${HELP}`);
      process.exit(2);
    }
  }
  return { dir, strict, record };
}

function buildContext(trajectory: Trajectory): StepContext {
  const { model, maxTokens, tools } = trajectory.stepContext ?? {};
  const ctx: StepContext = { tools: tools ?? [], model: model ?? "unknown" };
  if (maxTokens !== undefined) ctx.maxTokens = maxTokens;
  return ctx;
}

function loadTrajectories(dir: string, files: string[]): {
  loaded: Array<{ file: string; trajectory: Trajectory }>;
  failed: number;
} {
  const loaded: Array<{ file: string; trajectory: Trajectory }> = [];
  let failed = 0;
  for (const file of files) {
    try {
      const trajectory = JSON.parse(readFileSync(join(dir, file), "utf8")) as Trajectory;
      loaded.push({ file, trajectory });
    } catch (err) {
      failed++;
      console.error(`[ERROR] ${file}: cannot parse trajectory — ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return { loaded, failed };
}

/** Re-feed one trajectory through step() and rewrite its `expected` array in place. */
function recordFile(dir: string, file: string, trajectory: Trajectory): void {
  if (!Array.isArray(trajectory.inputs) || !Array.isArray(trajectory.expected)) {
    throw new Error("trajectory has no inputs/expected arrays");
  }
  if (trajectory.expected.length !== trajectory.inputs.length) {
    throw new Error(
      `expected has ${trajectory.expected.length} entries for ${trajectory.inputs.length} inputs`,
    );
  }
  const expected = recordTrajectory(trajectory, buildContext(trajectory));
  writeFileSync(
    join(dir, file),
    `${JSON.stringify({ ...trajectory, expected }, null, 2)}\n`,
  );
  console.log(`[RECORDED] ${trajectory.name || file} (${file}) — ${expected.length} steps`);
}

function runRecord(dir: string, files: string[]): void {
  let failed = 0;
  let totalSteps = 0;
  for (const file of files) {
    let trajectory: Trajectory;
    try {
      trajectory = JSON.parse(readFileSync(join(dir, file), "utf8")) as Trajectory;
    } catch (err) {
      failed++;
      console.error(`[ERROR] ${file}: cannot parse trajectory — ${err instanceof Error ? err.message : String(err)}`);
      continue;
    }
    try {
      recordFile(dir, file, trajectory);
      totalSteps += trajectory.inputs.length;
    } catch (err) {
      failed++;
      console.error(`[ERROR] ${file}: cannot record trajectory — ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  console.log(`\n${files.length - failed}/${files.length} trajectories recorded, ${totalSteps} steps total.`);
  console.log("Re-run without --record to confirm the refreshed fixtures replay clean.");
  if (failed > 0) process.exit(1);
}

function main(): void {
  const { dir, strict, record } = parseArgs(process.argv.slice(2));

  if (!existsSync(dir)) {
    console.error(`Trajectories directory not found: ${dir}`);
    process.exit(2);
  }
  const files = readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .sort();
  if (files.length === 0) {
    console.error(`No trajectory files (*.json) found in: ${dir}`);
    process.exit(2);
  }

  if (record) {
    if (!strict) {
      console.error("--record always captures the full (state, effects) pair; it cannot be combined with --loose.");
      process.exit(2);
    }
    runRecord(dir, files);
    return;
  }

  let failed = 0;
  let totalSteps = 0;
  const { loaded, failed: parseFailures } = loadTrajectories(dir, files);
  failed += parseFailures;
  for (const { file, trajectory } of loaded) {
    const result = replayTrajectory(trajectory, buildContext(trajectory), { strict });
    totalSteps += result.totalSteps;
    const tag = result.passed ? "PASS" : "FAIL";
    console.log(`[${tag}] ${result.trajectoryName || file} (${file})`);
    if (!result.passed) {
      failed++;
      console.log(`       ${result.summary}`);
      const first = result.steps[result.firstFailureIndex];
      if (first) {
        console.log(`       at step ${first.stepIndex} input=${JSON.stringify(first.input)}`);
      }
      if (result.firstFailureIndex === -1) {
        console.log("       refresh the fixture with --record after confirming the core change is intended");
      }
    }
  }

  const ok = files.length - parseFailures;
  console.log(`\n${ok}/${files.length} trajectories, ${totalSteps} steps total, ${strict ? "strict" : "loose"} mode${strict ? ", full (state, effects)" : ""}.`);
  if (failed > 0) process.exit(1);
}

main();
