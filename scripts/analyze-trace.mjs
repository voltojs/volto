#!/usr/bin/env node
/**
 * analyze-trace.mjs — Offline analyzer for volto trace JSONL files.
 *
 * Reads a trace file produced by `createTracingEventSink({ jsonlPath })`
 * (see apps/reference-cli) and prints a structured human-readable report.
 *
 * Usage:
 *   node scripts/analyze-trace.mjs [path]              # default: /tmp/agent-logs/trace.jsonl
 *   node scripts/analyze-trace.mjs path/to/trace.jsonl
 *   node scripts/analyze-trace.mjs --json [path]       # machine-readable JSON
 *   node scripts/analyze-trace.mjs --no-color [path]   # disable ANSI colors
 *
 * Pure stdlib (fs + readline). No third-party deps.
 */

import { readFileSync, existsSync } from "node:fs";
import { argv, exit, stdout } from "node:process";

// ─── argv parsing ────────────────────────────────────────────
const args = argv.slice(2);
const jsonOut = args.includes("--json");
const noColor = args.includes("--no-color") || !stdout.isTTY;
const positional = args.filter((a) => !a.startsWith("--"));
const tracePath = positional[0] ?? "/tmp/agent-logs/trace.jsonl";

if (!existsSync(tracePath)) {
  process.stderr.write(`Trace file not found: ${tracePath}\n`);
  process.stderr.write(`Usage: node scripts/analyze-trace.mjs [path] [--json] [--no-color]\n`);
  exit(1);
}

// ─── color helpers ───────────────────────────────────────────
const C = noColor
  ? new Proxy({}, { get: () => (s) => String(s) })
  : {
      bold: (s) => `\x1b[1m${s}\x1b[0m`,
      dim: (s) => `\x1b[2m${s}\x1b[0m`,
      red: (s) => `\x1b[31m${s}\x1b[0m`,
      green: (s) => `\x1b[32m${s}\x1b[0m`,
      yellow: (s) => `\x1b[33m${s}\x1b[0m`,
      cyan: (s) => `\x1b[36m${s}\x1b[0m`,
      magenta: (s) => `\x1b[35m${s}\x1b[0m`,
      gray: (s) => `\x1b[90m${s}\x1b[0m`,
    };

// ─── parse JSONL ─────────────────────────────────────────────
const raw = readFileSync(tracePath, "utf-8");
const events = [];
let lineNo = 0;
let badLines = 0;
for (const line of raw.split("\n")) {
  lineNo++;
  const trimmed = line.trim();
  if (!trimmed) continue;
  try {
    events.push(JSON.parse(trimmed));
  } catch {
    badLines++;
  }
}

if (events.length === 0) {
  process.stderr.write(`No events parsed from ${tracePath}.\n`);
  exit(1);
}

// ─── derive structure ────────────────────────────────────────

/** ts is "HH:mm:ss.SSS" — convert to ms-of-day for delta math */
function tsToMs(ts) {
  if (!ts || typeof ts !== "string") return null;
  const m = ts.match(/^(\d{2}):(\d{2}):(\d{2})\.(\d{3})$/);
  if (!m) return null;
  return ((+m[1] * 60 + +m[2]) * 60 + +m[3]) * 1000 + +m[4];
}

/** Compute pXX of a sorted ascending array. */
function percentile(sorted, p) {
  if (sorted.length === 0) return null;
  const idx = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return sorted[idx];
}

const firstTs = tsToMs(events[0].ts);
const lastTs = tsToMs(events[events.length - 1].ts);
const totalMs = firstTs != null && lastTs != null ? lastTs - firstTs : null;

// User messages
const userMsgs = events.filter((e) => e.type === "user_message");

// Turns: each ends with model_done; group events between model_done boundaries
const turns = [];
{
  let buf = [];
  for (const e of events) {
    buf.push(e);
    if (e.type === "model_done") {
      turns.push({
        events: buf,
        stopReason: e.data?.stopReason ?? "?",
        usage: e.data?.usage ?? null,
        endTs: tsToMs(e.ts),
        startTs: tsToMs(buf[0].ts),
      });
      buf = [];
    }
  }
  // Trailing events without a model_done (e.g. crashed turn)
  if (buf.length > 0) {
    turns.push({
      events: buf,
      stopReason: "(unfinished)",
      usage: null,
      endTs: tsToMs(buf[buf.length - 1].ts),
      startTs: tsToMs(buf[0].ts),
    });
  }
}

// Tool calls — pair tool_use_complete with subsequent tool_result by toolCallId
const completes = events.filter((e) => e.type === "tool_use_complete");
const results = events.filter((e) => e.type === "tool_result");
const resultsById = new Map();
for (const r of results) {
  const id = r.data?.toolCallId;
  if (id) resultsById.set(id, r);
}
const toolCalls = completes.map((c) => {
  const id = c.data?.toolCallId;
  const r = id ? resultsById.get(id) : null;
  return {
    id,
    name: c.data?.toolName ?? "?",
    input: c.data?.input,
    startTs: tsToMs(c.ts),
    endTs: r ? tsToMs(r.ts) : null,
    durationMs: r?.data?.durationMs ?? null,
    isError: r?.data?.isError ?? null,
    completed: r != null,
  };
});

// Per-tool aggregates
const byTool = new Map();
for (const tc of toolCalls) {
  if (!byTool.has(tc.name)) {
    byTool.set(tc.name, { name: tc.name, count: 0, errors: 0, durations: [] });
  }
  const agg = byTool.get(tc.name);
  agg.count++;
  if (tc.isError === true) agg.errors++;
  if (typeof tc.durationMs === "number") agg.durations.push(tc.durationMs);
}
const toolAggs = [...byTool.values()].map((a) => {
  const sorted = [...a.durations].sort((x, y) => x - y);
  const total = sorted.reduce((s, v) => s + v, 0);
  return {
    name: a.name,
    count: a.count,
    errors: a.errors,
    errorRate: a.count > 0 ? a.errors / a.count : 0,
    totalMs: total,
    avgMs: sorted.length > 0 ? total / sorted.length : null,
    p50Ms: percentile(sorted, 50),
    p95Ms: percentile(sorted, 95),
    maxMs: sorted.length > 0 ? sorted[sorted.length - 1] : null,
  };
});
toolAggs.sort((a, b) => (b.totalMs ?? 0) - (a.totalMs ?? 0));

// Errors
const errors = events.filter(
  (e) => e.type === "error" || e.type === "model_error" || e.type === "budget_exceeded",
);
const toolErrors = toolCalls.filter((tc) => tc.isError === true);

// Token usage (from model_done events that carry usage)
let totalInputTokens = 0;
let totalOutputTokens = 0;
let usageTurns = 0;
for (const t of turns) {
  if (t.usage && typeof t.usage.inputTokens === "number") {
    totalInputTokens += t.usage.inputTokens;
    totalOutputTokens += t.usage.outputTokens ?? 0;
    usageTurns++;
  }
}

// Cost (from cost_update events if present)
const costEvents = events.filter((e) => e.type === "cost_update");
const totalCostUsd = costEvents.length > 0
  ? Number(costEvents[costEvents.length - 1].data?.totalUsd) || 0
  : null;

// Approval / self-correct counts
const approvals = events.filter((e) => e.type === "approval_decision").length;
const selfCorrects = events.filter((e) => e.type === "self_correct").length;
const modelRetries = events.filter((e) => e.type === "model_retry").length;

// ─── machine-readable output ─────────────────────────────────
if (jsonOut) {
  console.log(JSON.stringify({
    file: tracePath,
    totalEvents: events.length,
    badLines,
    durationMs: totalMs,
    userMessages: userMsgs.length,
    turns: turns.map((t) => ({
      stopReason: t.stopReason,
      durationMs: t.endTs != null && t.startTs != null ? t.endTs - t.startTs : null,
      usage: t.usage,
      toolUseCount: t.events.filter((e) => e.type === "tool_use_complete").length,
    })),
    tools: {
      total: toolCalls.length,
      errors: toolErrors.length,
      perTool: toolAggs,
      calls: toolCalls,
    },
    errors,
    tokens: { input: totalInputTokens, output: totalOutputTokens, fromTurns: usageTurns },
    totalCostUsd,
    counts: { approvals, selfCorrects, modelRetries },
  }, null, 2));
  exit(0);
}

// ─── pretty output ───────────────────────────────────────────

function fmt(ms) {
  if (ms == null) return C.dim("?");
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(2)}s`;
}

function pad(s, w, right = false) {
  s = String(s);
  if (s.length >= w) return s;
  const fill = " ".repeat(w - s.length);
  return right ? fill + s : s + fill;
}

function header(title) {
  return `\n${C.bold(C.cyan("━━━ " + title + " ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━").slice(0, 70))}`;
}

const out = [];

// ── 1. Overview ─────────────────────────────────────────────
out.push(header("Overview"));
out.push(`  ${C.dim("file")}              ${tracePath}`);
out.push(`  ${C.dim("events")}            ${events.length}${badLines ? C.yellow(`  (${badLines} bad lines skipped)`) : ""}`);
out.push(`  ${C.dim("wallclock")}         ${fmt(totalMs)}`);
out.push(`  ${C.dim("user messages")}     ${userMsgs.length}`);
out.push(`  ${C.dim("turns")}             ${turns.length}`);
out.push(`  ${C.dim("tool calls")}        ${toolCalls.length}${toolErrors.length > 0 ? C.red(`  (${toolErrors.length} errored)`) : ""}`);
out.push(`  ${C.dim("errors")}            ${errors.length === 0 ? C.green("0") : C.red(errors.length)}`);
if (totalInputTokens || totalOutputTokens) {
  out.push(`  ${C.dim("tokens")}            ${C.cyan(totalInputTokens)} in + ${C.cyan(totalOutputTokens)} out  ${C.dim(`(${usageTurns}/${turns.length} turns reported)`)}`);
}
if (totalCostUsd != null) out.push(`  ${C.dim("cost")}              $${totalCostUsd.toFixed(4)}`);
if (approvals + selfCorrects + modelRetries > 0) {
  out.push(`  ${C.dim("ops")}               approvals=${approvals}  self-corrects=${selfCorrects}  model-retries=${modelRetries}`);
}

// ── 2. User messages & turn-by-turn ─────────────────────────
out.push(header("Turns"));
out.push(`  ${C.dim(pad("#", 3) + pad("start", 14) + pad("dur", 9) + pad("stop", 14) + pad("tools", 7) + pad("text", 7) + "usage")}`);
let turnIdx = 0;
for (const t of turns) {
  turnIdx++;
  const startStr = events.find((e) => tsToMs(e.ts) === t.startTs)?.ts?.slice(0, 12) ?? "?";
  const dur = t.endTs != null && t.startTs != null ? t.endTs - t.startTs : null;
  const tools = t.events.filter((e) => e.type === "tool_use_complete").length;
  const textChunks = t.events.filter((e) => e.type === "text_delta").length;
  const usage = t.usage
    ? `${t.usage.inputTokens ?? "?"}+${t.usage.outputTokens ?? "?"}`
    : C.dim("-");
  const stopColor =
    t.stopReason === "end_turn" ? C.green
    : t.stopReason === "tool_use" ? C.cyan
    : t.stopReason === "max_tokens" ? C.yellow
    : C.red;
  out.push(
    `  ${pad(turnIdx, 3)}${pad(startStr, 14)}${pad(fmt(dur), 9)}${stopColor(pad(t.stopReason, 14))}${pad(tools, 7)}${pad(textChunks, 7)}${usage}`,
  );
}

// Show user messages inline
if (userMsgs.length > 0) {
  out.push("");
  out.push(`  ${C.dim("user inputs:")}`);
  for (const u of userMsgs) {
    const text = String(u.data?.content ?? "").replace(/\n/g, " ");
    const preview = text.length > 70 ? text.slice(0, 67) + "…" : text;
    out.push(`    ${C.dim(u.ts?.slice(0, 12))}  ${preview}`);
  }
}

// ── 3. Tool calls (chronological) ───────────────────────────
if (toolCalls.length > 0) {
  out.push(header("Tool calls (chronological)"));
  out.push(`  ${C.dim(pad("ts", 14) + pad("tool#id", 22) + pad("ms", 8) + "input")}`);
  for (const tc of toolCalls) {
    const id = (tc.id ?? "").slice(0, 8);
    const startStr = events.find((e) => tsToMs(e.ts) === tc.startTs)?.ts?.slice(0, 12) ?? "?";
    const dur = tc.durationMs != null ? `${tc.durationMs}ms` : C.dim("?");
    const errMark = tc.isError === true ? C.red(" ✗") : tc.completed ? C.green(" ✓") : C.yellow(" …");
    const inputStr = tc.input == null ? "" : (typeof tc.input === "string" ? tc.input : JSON.stringify(tc.input));
    const inputPreview = inputStr.length > 60 ? inputStr.slice(0, 57) + "…" : inputStr;
    const toolLabel = `${tc.name}#${id}`;
    out.push(`  ${pad(startStr, 14)}${pad(toolLabel, 22)}${pad(dur, 8)}${C.dim(inputPreview)}${errMark}`);
  }
}

// ── 4. Tool aggregates ──────────────────────────────────────
if (toolAggs.length > 0) {
  out.push(header("Tool aggregates (by total time)"));
  out.push(`  ${C.dim(pad("tool", 18) + pad("calls", 7) + pad("err", 6) + pad("total", 9) + pad("avg", 8) + pad("p50", 8) + pad("p95", 8) + "max")}`);
  for (const a of toolAggs) {
    const errStr = a.errors > 0 ? C.red(pad(a.errors, 6)) : pad(a.errors, 6);
    out.push(
      `  ${pad(a.name, 18)}${pad(a.count, 7)}${errStr}${pad(fmt(a.totalMs), 9)}${pad(a.avgMs != null ? Math.round(a.avgMs) + "ms" : "-", 8)}${pad(fmt(a.p50Ms), 8)}${pad(fmt(a.p95Ms), 8)}${fmt(a.maxMs)}`,
    );
  }
}

// ── 5. Errors ───────────────────────────────────────────────
if (errors.length > 0 || toolErrors.length > 0) {
  out.push(header("Errors"));
  for (const e of errors) {
    const msg = String(e.data?.error ?? e.data?.reason ?? JSON.stringify(e.data)).replace(/\s+/g, " ");
    const preview = msg.length > 100 ? msg.slice(0, 97) + "…" : msg;
    out.push(`  ${C.red(pad(e.type, 18))}${C.dim(e.ts?.slice(0, 12))}  ${preview}`);
  }
  for (const tc of toolErrors) {
    out.push(`  ${C.red(pad("tool_failure", 18))}${tc.name}#${(tc.id ?? "").slice(0, 8)}  ${tc.durationMs ?? "?"}ms`);
  }
}

// ── 6. Closing line ─────────────────────────────────────────
out.push("");
out.push(C.dim(`(parsed ${events.length} events from ${tracePath})`));
out.push("");

stdout.write(out.join("\n"));
