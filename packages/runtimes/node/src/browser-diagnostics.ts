/**
 * Per-page diagnostics ring buffers.
 *
 * Console/page errors and failed/4xx/5xx requests are capped so a noisy page
 * cannot grow memory without bound. Response bodies are never captured.
 */

import type { DiagnosticsOutcome } from "@voltojs/tools/browser";

export type DiagnosticsLevel = "error" | "warning" | "info";

interface ConsoleRecord {
  at: number;
  level: DiagnosticsLevel;
  text: string;
}

interface NetworkRecord {
  at: number;
  method: string;
  url: string;
  status?: number;
  failure?: string;
}

export interface DiagnosticsFormatOptions {
  level?: DiagnosticsLevel;
  limit?: number;
}

export interface DiagnosticsBuffer {
  console(level: DiagnosticsLevel, text: string): void;
  networkFailure(method: string, url: string, failure: string): void;
  networkStatus(status: number, method: string, url: string): void;
  format(kind: "console" | "network", opts: DiagnosticsFormatOptions): DiagnosticsOutcome;
}

const DEFAULT_LIMIT = 50;

function clock(at: number): string {
  return new Date(at).toISOString().slice(11, 19);
}

export function createDiagnosticsBuffer(
  capacity = 200,
  now: () => number = Date.now,
): DiagnosticsBuffer {
  const consoleRecords: ConsoleRecord[] = [];
  const networkRecords: NetworkRecord[] = [];

  function push<T>(list: T[], record: T): void {
    list.push(record);
    if (list.length > capacity) list.splice(0, list.length - capacity);
  }

  return {
    console(level, text) {
      push(consoleRecords, { at: now(), level, text });
    },
    networkFailure(method, url, failure) {
      push(networkRecords, { at: now(), method, url, failure });
    },
    networkStatus(status, method, url) {
      push(networkRecords, { at: now(), method, url, status });
    },
    format(kind, opts) {
      const limit = opts.limit ?? DEFAULT_LIMIT;
      if (kind === "console") {
        const filtered = opts.level === undefined
          ? consoleRecords
          : consoleRecords.filter((record) => record.level === opts.level);
        const selected = filtered.slice(-limit);
        return {
          text: selected
            .map((record) => `[${clock(record.at)}] ${record.level}: ${record.text}`)
            .join("\n"),
          truncated: filtered.length > selected.length,
        };
      }
      const selected = networkRecords.slice(-limit);
      return {
        text: selected
          .map((record) =>
            record.status !== undefined
              ? `[${clock(record.at)}] ${record.status} ${record.method} ${record.url}`
              : `[${clock(record.at)}] failed ${record.method} ${record.url}: ${record.failure ?? "unknown"}`,
          )
          .join("\n"),
        truncated: networkRecords.length > selected.length,
      };
    },
  };
}