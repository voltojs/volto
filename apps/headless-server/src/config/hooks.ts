/**
 * Hooks config — `hooks.json` in the user config dir, compiled into core
 * `Hook[]` on each session build (same trust level and load discipline as
 * egress.json / permissions.json: user-edited, host-read, never
 * model-visible).
 *
 * Fail-closed: an unknown lifecycle key or an unknown entry field refuses
 * the whole file (throws) instead of silently dropping the entry — a user
 * who wrote a hook expects it to run. The accepted shape is the Claude
 * Code command-hook subset: `{ "<lifecycle>": [{ "type": "command", "command": "..." }] }`.
 *
 * Exit-code semantics (spec 2026-10-17 D2): `0` = continue (stdout
 * discarded — it never enters model context, D5); `2` = deny with the
 * trimmed FIRST stderr line as the reason (empty stderr → a default
 * no-reason text); any other non-zero exit, spawn failure, or timeout =
 * fail-closed deny — a user who wrote a hook wants it enforced, so
 * degrading to continue would be a silent policy hole.
 */

import { spawn } from "node:child_process";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { Hook, HookContext, HookLifecycle, HookOutcome } from "@volto/core";

/** Default per-hook wall-clock budget (spec D5): 10s, then SIGTERM + deny. */
export const DEFAULT_HOOK_TIMEOUT_MS = 10_000;

/**
 * Cap on collected hook stderr (chars). A spamming failing hook must not
 * be able to blow host memory: collection stops appending once the cap is
 * reached while the remaining bytes are still counted (and drained — the
 * data listener stays attached so the pipe never blocks). The deny reason
 * uses what was collected; the first line lives at the head of the stream
 * and survives the cap intact.
 */
export const STDERR_COLLECTION_CAP = 65_536;

/** A single external-command hook entry — the only accepted entry shape. */
export interface CommandHookSpec {
  type: "command";
  command: string;
}

export class HooksConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "HooksConfigError";
  }
}

/** Every lifecycle key hooks.json may use — mirrors core's HookLifecycle. */
const HOOK_LIFECYCLES: readonly HookLifecycle[] = [
  "session:start",
  "session:end",
  "turn:start",
  "turn:end",
  "preToolUse",
  "postToolUse",
  "userPromptSubmit",
  "preCompact",
  "subagentStop",
  "notification",
];

/** Validate one entry: exactly `{ type: "command", command: string }`. */
function parseEntry(lifecycle: string, value: unknown, index: number): CommandHookSpec {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new HooksConfigError(`hooks.json: "${lifecycle}" entry ${index} must be an object`);
  }
  const entry = value as Record<string, unknown>;
  const unknownFields = Object.keys(entry).filter((field) => field !== "type" && field !== "command");
  if (unknownFields.length > 0) {
    throw new HooksConfigError(
      `hooks.json: "${lifecycle}" entry ${index} has unknown field(s): ${unknownFields.join(", ")} — expected only type / command`,
    );
  }
  if (entry.type !== "command") {
    throw new HooksConfigError(
      `hooks.json: "${lifecycle}" entry ${index} has unsupported type ${JSON.stringify(entry.type)} — only "command" is supported`,
    );
  }
  if (typeof entry.command !== "string" || entry.command.trim().length === 0) {
    throw new HooksConfigError(
      `hooks.json: "${lifecycle}" entry ${index} must carry a non-empty "command" string`,
    );
  }
  return { type: "command", command: entry.command };
}

/**
 * Parse a hooks.json object (already JSON.parsed) into per-lifecycle spec
 * lists. Throws `HooksConfigError` on anything that is not exactly the
 * accepted shape; an empty object is a legal explicit no-hook config.
 */
export function parseHooksConfig(raw: unknown): Map<HookLifecycle, CommandHookSpec[]> {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new HooksConfigError("hooks.json must be a JSON object");
  }
  const obj = raw as Record<string, unknown>;
  const unknownKeys = Object.keys(obj).filter(
    (key) => !(HOOK_LIFECYCLES as readonly string[]).includes(key),
  );
  if (unknownKeys.length > 0) {
    throw new HooksConfigError(
      `hooks.json has unknown key(s): ${unknownKeys.join(", ")} — expected lifecycle names (${HOOK_LIFECYCLES.join(" / ")})`,
    );
  }

  const specs = new Map<HookLifecycle, CommandHookSpec[]>();
  for (const [key, value] of Object.entries(obj)) {
    const lifecycle = key as HookLifecycle;
    if (!Array.isArray(value)) {
      throw new HooksConfigError(`hooks.json: "${key}" must be an array of hook entries`);
    }
    specs.set(lifecycle, value.map((entry, index) => parseEntry(key, entry, index)));
  }
  return specs;
}

/**
 * Run one external-command hook (spec D5): spawn with `shell: true` (the
 * command is the user's own — `~/` expansion through the login shell is
 * the point, there is no injection surface to argue about), feed the hook
 * context as JSON on stdin, collect the exit code and stderr, and map them
 * onto a `HookOutcome` per D2. stdout is drained and discarded — it never
 * enters model context; only the exit code (and, on an explicit deny, the
 * first stderr line) decides anything.
 *
 * Timeout (default `DEFAULT_HOOK_TIMEOUT_MS`): SIGTERM the child, then
 * fail-closed deny — one wedged hook must not stall the whole turn.
 *
 * Serial execution of multiple hooks on one lifecycle is the pipeline's
 * job (`runHookPipeline`); this function runs exactly one command.
 */
export function runCommandHook(
  command: string,
  ctx: HookContext,
  opts?: { timeoutMs?: number },
): Promise<HookOutcome> {
  const timeoutMs = opts?.timeoutMs ?? DEFAULT_HOOK_TIMEOUT_MS;
  return new Promise((resolve) => {
    let settled = false;
    const settle = (outcome: HookOutcome) => {
      if (settled) return;
      settled = true;
      resolve(outcome);
    };
    const failClosed = (detail: string) =>
      settle({ action: "deny", reason: `hook "${command}" failed: ${detail}` });

    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(command, { shell: true });
    } catch (err) {
      failClosed(err instanceof Error ? err.message : String(err));
      return;
    }

    let stderr = "";
    let stderrDroppedChars = 0;
    child.stderr?.setEncoding("utf-8");
    child.stderr?.on("data", (chunk: string) => {
      // Bounded accumulation (mirror of the T5 bash output cap): stop
      // appending at the cap, keep counting what was dropped. The listener
      // stays attached either way, so the pipe keeps draining and a
      // spamming failing hook cannot block or blow host memory.
      if (stderr.length >= STDERR_COLLECTION_CAP) {
        stderrDroppedChars += chunk.length;
        return;
      }
      const room = STDERR_COLLECTION_CAP - stderr.length;
      if (chunk.length <= room) {
        stderr += chunk;
      } else {
        stderr += chunk.slice(0, room);
        stderrDroppedChars += chunk.length - room;
      }
    });
    // stdout is discarded by spec (D5) — but it must still be drained, or a
    // chatty hook could fill the pipe and block on write.
    child.stdout?.resume();

    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      failClosed(`timed out after ${timeoutMs}ms`);
    }, timeoutMs);

    child.on("error", (err) => {
      clearTimeout(timer);
      failClosed(err.message);
    });

    child.on("close", (code, signal) => {
      clearTimeout(timer);
      if (settled) return;
      if (code === 0) {
        settle({ action: "continue" });
        return;
      }
      if (code === 2) {
        // The first line lives at the head of the stream, so the cap never
        // costs it: the deny reason is derived from the capped buffer.
        const firstLine = (stderr.split("\n", 1)[0] ?? "").trim();
        settle({
          action: "deny",
          reason: firstLine.length > 0 ? firstLine : "hook denied without a reason",
        });
        return;
      }
      // Non-zero (incl. killed by an external signal, code === null) →
      // fail-closed deny with the exit detail. Dropped stderr (beyond the
      // collection cap) is disclosed, mirroring the bash truncation note.
      const truncationNote =
        stderrDroppedChars > 0
          ? ` (stderr truncated: ${stderrDroppedChars} chars dropped)`
          : "";
      failClosed(
        (code === null ? `killed by signal ${signal ?? "unknown"}` : `exit ${code}`) +
          truncationNote,
      );
    });

    // A hook that exits without reading stdin surfaces EPIPE here; the
    // close handler still decides the outcome, so swallow it.
    child.stdin?.on("error", () => {});
    child.stdin?.end(JSON.stringify(ctx));
  });
}

/**
 * Load and compile `<configDir>/hooks.json` for one session build — same
 * reload discipline as egress.json / permissions.json (an edit reaches new
 * sessions without a restart).
 *
 * Returns `null` for an absent file (no hooks, treated as silence) and
 * throws `HooksConfigError` for anything present-but-unusable (unreadable,
 * invalid JSON, rejected shape) — the CALLER decides how to react: wiring
 * treats a parse failure as fail-open for service availability (spec §6:
 * warn and build without config hooks), because refusing to load is not
 * the same as refusing a policy the way egress does.
 */
export async function loadHooksConfig(configDir: string): Promise<Hook[] | null> {
  const file = path.join(configDir, "hooks.json");
  let raw: string;
  try {
    raw = await fs.readFile(file, "utf-8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw new HooksConfigError(
      `hooks.json exists but could not be read: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new HooksConfigError(
      `hooks.json is not valid JSON: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  return buildHooksFromConfig(parseHooksConfig(parsed));
}

/**
 * Compile parsed specs into core `Hook[]` — name `cfg:<lifecycle>:<index>`,
 * lifecycle-bound, deterministic order (Map insertion order, entry order
 * within a lifecycle). The handler runs the configured command through
 * `runCommandHook` with the spec's default timeout.
 */
export function buildHooksFromConfig(specs: Map<HookLifecycle, CommandHookSpec[]>): Hook[] {
  const hooks: Hook[] = [];
  for (const [lifecycle, entries] of specs) {
    entries.forEach((spec, index) => {
      const name = `cfg:${lifecycle}:${index}`;
      hooks.push({
        name,
        lifecycle,
        handler: (ctx) =>
          runCommandHook(spec.command, ctx, { timeoutMs: DEFAULT_HOOK_TIMEOUT_MS }),
      });
    });
  }
  return hooks;
}
