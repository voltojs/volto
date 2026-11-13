#!/usr/bin/env node
/**
 * volto-eval-replay — deterministic trajectory regression runner (CI gate).
 *
 * Scans `*.json` trajectory files in a directory, replays each through the
 * pure step() reducer (strict mode by default: full (state, effects)
 * consistency), prints a per-trajectory report and exits non-zero on any
 * failure — the M11 "重放式 eval" acceptance as a CI check.
 *
 * Usage:
 *   node dist/cli.js [--dir <trajectories-dir>] [--loose] [--help]
 *
 * Options:
 *   --dir <path>   directory of trajectory JSON files
 *                  (default: <package>/trajectories)
 *   --loose        legacy partial comparison (status + effect type names)
 *   --help, -h     show this help
 */

import { readdirSync, readFileSync, existsSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { replayTrajectory } from "./replay.js";
import type { Trajectory } from "./trajectory.js";
import type { StepContext } from "@voltojs/core";

const THIS_DIR = dirname(fileURLToPath(import.meta.url));

const HELP = `volto-eval-replay — trajectory regression runner

Usage: node dist/cli.js [--dir <trajectories-dir>] [--loose] [--help]

Options:
  --dir <path>   directory of trajectory JSON files
                 (default: <package>/trajectories)
  --loose        legacy partial comparison (status + effect type names)
  --help, -h     show this help

Exit codes:
  0  all trajectories passed
  1  at least one trajectory failed
  2  usage / environment error (missing dir or no trajectory files)
`;

function parseArgs(argv: string[]): { dir: string; strict: boolean } {
  let dir = resolve(THIS_DIR, "../trajectories");
  let strict = true;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if ((arg === "--dir" || arg === "-d") && argv[i + 1]) {
      dir = resolve(argv[i + 1]!);
      i++;
    } else if (arg === "--loose") {
      strict = false;
    } else if (arg === "--help" || arg === "-h") {
      console.log(HELP);
      process.exit(0);
    } else {
      console.error(`Unknown argument: ${arg}\n\n${HELP}`);
      process.exit(2);
    }
  }
  return { dir, strict };
}

function buildContext(trajectory: Trajectory): StepContext {
  const { model, maxTokens, tools } = trajectory.stepContext ?? {};
  const ctx: StepContext = { tools: tools ?? [], model: model ?? "unknown" };
  if (maxTokens !== undefined) ctx.maxTokens = maxTokens;
  return ctx;
}

function main(): void {
  const { dir, strict } = parseArgs(process.argv.slice(2));

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
    }
  }

  console.log(`\n${files.length - failed}/${files.length} trajectories, ${totalSteps} steps total, ${strict ? "strict" : "loose"} mode.`);
  if (failed > 0) process.exit(1);
}

main();
