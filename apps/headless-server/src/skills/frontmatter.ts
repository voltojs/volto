/**
 * SKILL.md frontmatter parsing: a YAML subset, not a YAML parser.
 *
 * Skill frontmatter fields are all scalars (no nested maps or sequences), so
 * a dependency-free subset is enough — but it must cover what SKILL.md files
 * in the Claude/dsh ecosystem actually use, notably the folded (`>`/`>-`) and
 * literal (`|`/`|-`) block scalars that multi-sentence descriptions rely on.
 * A naive `indexOf(":")` split parses those as the literal string ">-".
 */

import type { SkillInvocationPolicy } from "@volto/core";

export interface ParsedSkillFile {
  name: string;
  description: string;
  invocation: SkillInvocationPolicy;
  /** Markdown body after the frontmatter, trimmed. */
  body: string;
}

/** Strips one pair of matching surrounding quotes, if present. */
function unquote(value: string): string {
  if (value.length >= 2) {
    const first = value[0];
    const last = value[value.length - 1];
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
      return value.slice(1, -1);
    }
  }
  return value;
}

type BlockStyle = "folded" | "literal";

/** Parses the `key: value` lines of a frontmatter block into a flat map. */
function parseFields(frontmatter: string): Record<string, string> {
  const fields: Record<string, string> = {};
  const lines = frontmatter.split("\n");
  let currentKey: string | undefined;
  let blockStyle: BlockStyle | undefined;
  let blockChomp = false;
  let blockLines: string[] = [];

  const flushBlock = (): void => {
    if (currentKey === undefined || blockStyle === undefined) return;
    const joined =
      blockStyle === "folded" ? blockLines.join(" ") : blockLines.join("\n");
    fields[currentKey] = blockChomp ? joined.replace(/\n+$/, "") : joined;
    blockStyle = undefined;
    blockChomp = false;
    blockLines = [];
  };

  for (const line of lines) {
    const indented = /^\s+\S/.test(line);

    if (blockStyle !== undefined) {
      if (indented || line.trim().length === 0) {
        blockLines.push(line.trim());
        continue;
      }
      flushBlock();
    }

    if (line.trim().startsWith("#")) continue;

    // An indented line with no active block continues the previous scalar.
    if (indented && currentKey !== undefined) {
      fields[currentKey] = `${fields[currentKey] ?? ""} ${line.trim()}`.trim();
      continue;
    }

    const idx = line.indexOf(":");
    if (idx < 0) continue;
    const key = line.slice(0, idx).trim();
    if (key.length === 0) continue;
    const rawValue = line.slice(idx + 1).trim();
    currentKey = key;

    const blockMatch = rawValue.match(/^([|>])(-?)$/);
    if (blockMatch) {
      blockStyle = blockMatch[1] === ">" ? "folded" : "literal";
      blockChomp = blockMatch[2] === "-";
      blockLines = [];
      continue;
    }

    fields[key] = unquote(rawValue);
  }

  flushBlock();
  return fields;
}

/**
 * Parses a SKILL.md file into metadata plus body. Returns undefined when the
 * file has no frontmatter or lacks name/description — i.e. it is not a skill.
 */
export function parseSkillFile(raw: string): ParsedSkillFile | undefined {
  // Windows-authored SKILL.md files use CRLF; normalize once so the
  // frontmatter regex and field splitting both see bare \n.
  const normalized = raw.replace(/\r\n/g, "\n");
  const match = normalized.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  if (!match) return undefined;
  const [, frontmatter, body] = match;
  const fields = parseFields(frontmatter!);
  if (!fields["name"] || !fields["description"]) return undefined;
  // Invocation policy — dsh-compatible frontmatter flags. Absence of a flag
  // keeps the default (model- and user-invocable); `true`/`false` are the
  // only recognized values, anything else parses as "enabled".
  const invocation: SkillInvocationPolicy = {
    modelInvocable: fields["disable-model-invocation"] !== "true",
    userInvocable: fields["user-invocable"] !== "false",
  };
  return {
    name: fields["name"]!,
    description: fields["description"]!,
    invocation,
    body: body!.trim(),
  };
}
