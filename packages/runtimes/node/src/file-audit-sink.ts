/**
 * File-based AuditSink — writes structured audit entries to a JSONL file.
 *
 * Each entry is a single JSON line, making it easy to tail, grep, or pipe
 * into log aggregators (Datadog, Loki, etc.).
 *
 * Usage:
 *   import { createFileAuditSink } from "@agent-core/runtime-node";
 *   const auditSink = createFileAuditSink("/var/log/agent-audit.jsonl");
 */

import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { AuditEntry, AuditSink } from "./runner.js";

/**
 * Create a file-based audit sink that appends JSONL entries to the given path.
 * The parent directory is created automatically if it doesn't exist.
 *
 * @param filePath Path to the JSONL audit log file
 * @returns An AuditSink that writes entries to the file
 */
export function createFileAuditSink(filePath: string): AuditSink {
  // Ensure parent directory exists
  mkdirSync(dirname(filePath), { recursive: true });

  return {
    record(entry: AuditEntry): void {
      const line = JSON.stringify({
        ...entry,
        _ts: new Date(entry.timestamp).toISOString(),
      }) + "\n";
      appendFileSync(filePath, line, "utf-8");
    },
  };
}
