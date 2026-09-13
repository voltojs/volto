/**
 * Slash commands — M13 Phase 5.
 *
 * Commands are named prompt templates + parameter schemas.
 * `renderCommand` is a pure function that expands a command + raw args
 * into a UserMessage string. Unknown commands return a normalized
 * prompt text (no throw).
 */

import type { JSONSchema } from "@volto/core";

// ──────────────────────────────────────────────
// Types
// ──────────────────────────────────────────────

export interface SlashCommand {
  /** Command name (without leading /) */
  name: string;
  /** Scope: user-level or project-level */
  scope?: "user" | "project";
  /** Prompt template — supports {{argName}} placeholders */
  template: string;
  /** Optional argument schema (JSON Schema, informational) */
  args?: JSONSchema;
  /** Human-readable summary shown in command menus. Purely informational —
   *  matchCommand/renderCommand never read it. */
  description?: string;
}

// ──────────────────────────────────────────────
// Pure rendering
// ──────────────────────────────────────────────

/**
 * Parse raw args string into a simple key=value map.
 * Supports: `/cmd key1=val1 key2="val with spaces"` and positional args.
 * Positional args are keyed as "0", "1", "2", etc.
 */
export function parseArgs(raw: string): Record<string, string> {
  const result: Record<string, string> = {};
  const trimmed = raw.trim();
  if (!trimmed) return result as unknown as Record<string, string>;

  let positionalIdx = 0;
  let i = 0;
  while (i < trimmed.length) {
    // skip whitespace
    while (i < trimmed.length && trimmed[i] === " ") i++;
    if (i >= trimmed.length) break;

    // check for key=value
    const eqIdx = trimmed.indexOf("=", i);
    const spaceIdx = trimmed.indexOf(" ", i);

    if (eqIdx !== -1 && (spaceIdx === -1 || eqIdx < spaceIdx)) {
      // key=value pair
      const key = trimmed.slice(i, eqIdx);
      i = eqIdx + 1;
      if (i < trimmed.length && trimmed[i] === '"') {
        // quoted value
        i++; // skip opening quote
        const closeIdx = trimmed.indexOf('"', i);
        if (closeIdx !== -1) {
          result[key] = trimmed.slice(i, closeIdx);
          i = closeIdx + 1;
        } else {
          result[key] = trimmed.slice(i);
          i = trimmed.length;
        }
      } else {
        // unquoted value
        const nextSpace = trimmed.indexOf(" ", i);
        if (nextSpace !== -1) {
          result[key] = trimmed.slice(i, nextSpace);
          i = nextSpace;
        } else {
          result[key] = trimmed.slice(i);
          i = trimmed.length;
        }
      }
    } else {
      // positional arg
      const nextSpace = trimmed.indexOf(" ", i);
      if (nextSpace !== -1) {
        result[String(positionalIdx)] = trimmed.slice(i, nextSpace);
        i = nextSpace;
      } else {
        result[String(positionalIdx)] = trimmed.slice(i);
        i = trimmed.length;
      }
      positionalIdx++;
    }
  }

  return result;
}

/**
 * Extracts the command name from a raw `/name ...` input the same way
 * `renderCommand` does, and looks it up — without rendering. Lets a caller
 * (createAgent's resolveInput) check synchronously "does a registered
 * command match this name?" before deciding whether to fall through to an
 * (async) skill lookup, without duplicating the name-parsing rule.
 * Returns undefined for non-command input or an unmatched name.
 */
export function matchCommand(
  commands: SlashCommand[],
  input: string,
): SlashCommand | undefined {
  const trimmed = input.trim();
  if (!trimmed.startsWith("/")) return undefined;
  const spaceIdx = trimmed.indexOf(" ");
  const cmdName = spaceIdx !== -1 ? trimmed.slice(1, spaceIdx) : trimmed.slice(1);
  return findCommand(commands, cmdName);
}

/**
 * Pure function: render a slash command template with args into a string.
 *
 * Placeholders in template: `{{key}}` is replaced by args[key].
 * Unmatched placeholders are removed.
 * If no matching command is found, returns a normalized unknown-command prompt.
 */
export function renderCommand(
  commands: SlashCommand[],
  input: string,
): string {
  const trimmed = input.trim();
  if (!trimmed.startsWith("/")) {
    return trimmed; // not a command — pass through
  }

  const spaceIdx = trimmed.indexOf(" ");
  const cmdName = spaceIdx !== -1 ? trimmed.slice(1, spaceIdx) : trimmed.slice(1);
  const rawArgs = spaceIdx !== -1 ? trimmed.slice(spaceIdx + 1) : "";

  const cmd = matchCommand(commands, input);
  if (!cmd) {
    return `Unknown command: /${cmdName}. Available commands: ${commands.map((c) => `/${c.name}`).join(", ") || "none"}.`;
  }

  const args = parseArgs(rawArgs);

  // Render template: replace {{key}} with args[key], remove unmatched placeholders
  let rendered = cmd.template;
  for (const [key, value] of Object.entries(args)) {
    rendered = rendered.replaceAll(`{{${key}}}`, value);
  }
  // Remove unmatched {{...}} placeholders
  rendered = rendered.replaceAll(/\{\{[^}]+\}\}/g, "");

  return rendered.trim();
}

// ──────────────────────────────────────────────
// Command registry helper
// ──────────────────────────────────────────────

/**
 * Look up a command by name (without leading /).
 * Returns undefined if not found.
 */
export function findCommand(commands: SlashCommand[], name: string): SlashCommand | undefined {
  return commands.find((c) => c.name === name);
}
