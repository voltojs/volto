/**
 * Tracing EventSink — verbose, color-coded view of every event the agent
 * core emits during a turn. Wraps an inner sink (typically the rendering
 * sink that writes user-visible text to stdout) so existing UX is preserved
 * while adding a structured trace channel on stderr (and optional JSONL).
 *
 * This is purely a host-side concern: the core never observes it. Toggle
 * via env vars (see main.ts):
 *   AGENT_TRACE=true              enable tracing
 *   AGENT_TRACE_FILE=/path.jsonl  also persist as JSONL (one event per line)
 *   AGENT_TRACE_INCLUDE=a,b,c     comma-separated event-type allowlist
 */

import { appendFileSync, mkdirSync, openSync, closeSync } from "node:fs";
import { dirname } from "node:path";
import type { EventSink } from "@agent-core/core";

export interface TracingSinkOptions {
  /** Inner sink that still receives every event (e.g. user-visible renderer). */
  inner?: EventSink;
  /** Where to write trace lines (typically stderr). */
  write: (s: string) => void;
  /** Optional event-type allowlist. If unset, all events are traced. */
  include?: ReadonlyArray<string>;
  /** Optional JSONL path; appended one event per line. Parent dirs created. */
  jsonlPath?: string;
  /** Disable ANSI colors (e.g. when stderr isn't a TTY). */
  noColor?: boolean;
}

const COLORS: Record<string, string> = {
  text_delta: "\x1b[37m",        // dim white
  reasoning_delta: "\x1b[90m",   // gray
  tool_use_delta: "\x1b[36m",    // cyan
  tool_use_complete: "\x1b[1;36m", // bold cyan
  tool_result: "\x1b[32m",       // green
  model_done: "\x1b[90m",        // gray
  model_retry: "\x1b[33m",       // yellow
  model_error: "\x1b[31m",       // red
  budget_exceeded: "\x1b[31m",   // red
  approval_decision: "\x1b[35m", // magenta
  request_approval: "\x1b[35m",  // magenta
  self_correct: "\x1b[33m",      // yellow
  cancel: "\x1b[31m",            // red
};
const RESET = "\x1b[0m";

export function createTracingEventSink(opts: TracingSinkOptions): EventSink {
  const includeSet = opts.include ? new Set(opts.include) : null;
  const useColor = !opts.noColor;

  let fd: number | null = null;
  if (opts.jsonlPath) {
    mkdirSync(dirname(opts.jsonlPath), { recursive: true });
    fd = openSync(opts.jsonlPath, "a");
    // Best-effort close on exit — we don't manage the lifetime ourselves
    // beyond this; the OS will reclaim the fd if the process aborts.
    process.once("exit", () => {
      if (fd !== null) {
        try {
          closeSync(fd);
        } catch {
          // ignore
        }
      }
    });
  }

  return {
    emit(event) {
      // 1. Always forward to the inner sink first so user-visible rendering
      //    runs even if tracing throws (defensive).
      try {
        opts.inner?.emit(event);
      } catch {
        // swallow — tracing must not break the inner pipeline either way
      }

      // 2. Filter by event type
      if (includeSet && !includeSet.has(event.type)) return;

      // 3. Format a one-line summary for stderr
      const ts = new Date().toISOString().slice(11, 23);
      const summary = summarize(event);
      const depth = typeof event.data["agentDepth"] === "number"
        ? (event.data["agentDepth"] as number)
        : 0;
      const indent = depth > 0 ? "  ".repeat(depth) + `[d${depth}] ` : "";
      const color = useColor ? (COLORS[event.type] ?? "\x1b[34m") : "";
      const reset = useColor ? RESET : "";
      const line = `${color}[${ts}] ${indent}${event.type.padEnd(20)} ${summary}${reset}\n`;

      try {
        opts.write(line);
      } catch {
        // ignore write errors on stderr
      }

      // 4. JSONL persistence
      if (opts.jsonlPath) {
        try {
          appendFileSync(
            opts.jsonlPath,
            JSON.stringify({ ts, type: event.type, data: event.data }) + "\n",
            "utf-8",
          );
        } catch {
          // ignore — tracing must never crash the agent
        }
      }
    },
  };
}

function summarize(event: { type: string; data: Record<string, unknown> }): string {
  const d = event.data;
  switch (event.type) {
    case "text_delta": {
      const text = String(d["text"] ?? "");
      return JSON.stringify(text.length > 80 ? text.slice(0, 77) + "…" : text);
    }
    case "reasoning_delta": {
      const text = String(d["text"] ?? "");
      return JSON.stringify(text.length > 80 ? text.slice(0, 77) + "…" : text);
    }
    case "tool_use_delta": {
      // reducer-emitted shape: { phase: "start"|"args", toolCallId, toolName, argumentsDelta }
      const phase = d["phase"] ?? "?";
      const name = d["toolName"] ?? "?";
      const id = String(d["toolCallId"] ?? "?").slice(0, 8);
      const args = d["argumentsDelta"] ?? "";
      const argStr = typeof args === "string" ? args : JSON.stringify(args);
      const argPreview = argStr.length > 80 ? argStr.slice(0, 77) + "…" : argStr;
      return `${name}#${id} [${phase}] ${argPreview}`;
    }
    case "tool_use_complete": {
      // Emitted once per fully-assembled tool call before it executes.
      const name = d["toolName"] ?? "?";
      const id = String(d["toolCallId"] ?? "?").slice(0, 8);
      const input = d["input"];
      const argStr = typeof input === "string" ? input : JSON.stringify(input);
      const argPreview = argStr.length > 120 ? argStr.slice(0, 117) + "…" : argStr;
      return `${name}#${id}  ${argPreview}`;
    }
    case "tool_result": {
      const name = d["toolName"] ?? d["name"] ?? "?";
      const id = String(d["toolCallId"] ?? "?").slice(0, 8);
      const ms = d["durationMs"];
      const isErr = d["isError"] ? " ERROR" : "";
      const dur = typeof ms === "number" ? ` ${ms}ms` : "";
      return `${name}#${id}${dur}${isErr}`;
    }
    case "model_done": {
      const stop = d["stopReason"] ?? "?";
      const usage = d["usage"];
      return `stop=${stop}${usage ? ` usage=${JSON.stringify(usage)}` : ""}`;
    }
    case "model_retry": {
      return `attempt=${d["attempt"]} delay=${d["delayMs"]}ms`;
    }
    case "model_error": {
      return `${d["error"]}${d["errorKind"] ? ` kind=${d["errorKind"]}` : ""}${d["retriable"] ? " retriable" : ""}`;
    }
    case "budget_exceeded": {
      return String(d["reason"] ?? "");
    }
    case "approval_decision": {
      return `${d["toolName"] ?? "?"} → ${d["decision"] ?? "?"}`;
    }
    case "request_approval": {
      return `${d["toolName"] ?? "?"} riskTier=${d["riskTier"] ?? "?"}`;
    }
    case "self_correct": {
      return String(d["reason"] ?? "");
    }
    case "cancel": {
      return String(d["reason"] ?? "");
    }
    case "cost_update": {
      return `delta=$${d["deltaUsd"] ?? "?"} total=$${d["totalUsd"] ?? "?"}`;
    }
    default: {
      // Compact preview of unknown event payloads
      const keys = Object.keys(d).slice(0, 4);
      return keys.length === 0 ? "" : keys.map((k) => `${k}=${preview(d[k])}`).join(" ");
    }
  }
}

function preview(v: unknown): string {
  if (v === null || v === undefined) return String(v);
  if (typeof v === "string") return v.length > 30 ? JSON.stringify(v.slice(0, 27) + "…") : JSON.stringify(v);
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  try {
    const s = JSON.stringify(v);
    return s.length > 40 ? s.slice(0, 37) + "…" : s;
  } catch {
    return "[unserializable]";
  }
}
