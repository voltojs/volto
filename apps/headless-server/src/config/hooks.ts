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
 * Note on the compiled handler: command execution (spawn, stdin feed,
 * exit-code semantics, timeout) lands in Task 2 (`runCommandHook`). Until
 * then the compiled handler throws rather than silently continuing — a
 * config hook must never degrade into a no-op.
 */

import type { Hook, HookLifecycle } from "@volto/core";

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
 * Compile parsed specs into core `Hook[]` — name `cfg:<lifecycle>:<index>`,
 * lifecycle-bound, deterministic order (Map insertion order, entry order
 * within a lifecycle).
 */
export function buildHooksFromConfig(specs: Map<HookLifecycle, CommandHookSpec[]>): Hook[] {
  const hooks: Hook[] = [];
  for (const [lifecycle, entries] of specs) {
    entries.forEach((_spec, index) => {
      const name = `cfg:${lifecycle}:${index}`;
      hooks.push({
        name,
        lifecycle,
        // Task 2 wires runCommandHook here. Until then, fail loudly: a
        // configured hook must never degrade into a silent no-op.
        handler: () => {
          throw new Error(`config hook "${name}" is not wired yet`);
        },
      });
    });
  }
  return hooks;
}
