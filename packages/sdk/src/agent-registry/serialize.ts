/**
 * AgentSpec → definition-file rendering.
 *
 * The inverse of frontmatter.ts's parseAgentFile. Key order is fixed so the
 * same spec always renders to identical bytes — otherwise every save through
 * the host UI would produce a meaningless git diff.
 */

import type { AgentSpec } from "../agent-spec.js";

/**
 * Renders a value in the YAML subset frontmatter.ts parses: bare scalars
 * when unambiguous, quoted strings when a bare word would be misread as
 * another type (number / bool / null) or contains structure characters.
 */
function formatScalar(value: unknown): string {
  if (typeof value === "string") {
    if (
      value === "" ||
      /^(true|false|null|~|-?\d+(\.\d+)?)$/i.test(value) ||
      /[:#,[\]{}"'\\]|^\s|\s$/.test(value)
    ) {
      return JSON.stringify(value);
    }
    return value;
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  if (value === null) return "null";
  if (Array.isArray(value)) {
    return `[${value.map((v) => formatScalar(v)).join(", ")}]`;
  }
  if (typeof value === "object") {
    // Keys go through the same quoting as values: a JSON Schema property
    // name containing `,` or `:` would otherwise render ambiguously (the
    // parser splits entries on `,` and key/value on the first `:`).
    const entries = Object.entries(value as Record<string, unknown>).map(
      ([k, v]) => `${formatScalar(k)}: ${formatScalar(v)}`,
    );
    return `{${entries.join(", ")}}`;
  }
  return JSON.stringify(value);
}

/**
 * Render an AgentSpec back to a definition file.
 *
 * Unknown frontmatter keys are written back verbatim: a definition may have
 * been hand-authored with fields this build does not know, and silently
 * dropping them would make one edit through the UI destroy them.
 */
export function serializeAgentFile(
  spec: AgentSpec,
  unknownKeys: Record<string, unknown> = {},
): string {
  const lines: string[] = [];
  const written = new Set<string>();
  const push = (key: string, value: unknown): void => {
    if (value === undefined) return;
    written.add(key);
    lines.push(`${key}: ${formatScalar(value)}`);
  };

  // Fixed order: primary identity fields first, then the rest of the owned
  // fields, then preserved unknown keys last.
  push("name", spec.name);
  push("description", spec.description);
  push("tools", spec.tools);
  push("model", spec.model);
  push("capabilities", spec.capabilities);
  push("policy", spec.policy);
  push("maxTokens", spec.maxTokens);
  push("temperature", spec.temperature);
  push("reasoningEffort", spec.reasoningEffort);
  push("enableTaskTool", spec.enableTaskTool);
  push("maxIterations", spec.maxIterations);
  push("maxToolCalls", spec.maxToolCalls);
  push("responseFormat", spec.responseFormat);

  for (const [key, value] of Object.entries(unknownKeys)) {
    // A key already written from the spec must not appear twice.
    if (written.has(key) || value === undefined) continue;
    push(key, value);
  }

  const frontmatter = `---\n${lines.join("\n")}\n---\n`;
  return spec.systemPrompt !== undefined && spec.systemPrompt !== ""
    ? `${frontmatter}\n${spec.systemPrompt}\n`
    : frontmatter;
}
