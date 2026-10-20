/**
 * Session export renderers — pure functions over a transcript's meta + events.
 *
 * Markdown is the human-readable form (turns, text, tool summaries); JSONL
 * mirrors the store's v2 line shape so an export can be placed back into a
 * sessions directory. Neither renderer reads files or the clock.
 */

import type { ChatSessionMeta, TranscriptEvent } from "./ports.js";

function iso(time: number): string {
  return new Date(time).toISOString();
}

function contentText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((block) => {
      if (typeof block !== "object" || block === null) return "";
      const record = block as Record<string, unknown>;
      if (record["type"] === "text" && typeof record["text"] === "string") return record["text"];
      if (record["type"] === "image") {
        const source = record["source"];
        if (typeof source === "object" && source !== null) {
          const src = source as Record<string, unknown>;
          if (src["type"] === "ref" && typeof src["id"] === "string") {
            return `[image attachment:${src["id"]}]`;
          }
        }
        return "[image]";
      }
      return "";
    })
    .filter((text) => text !== "")
    .join("\n");
}

function toolResultSummary(content: unknown): string {
  const text = contentText(content).replace(/\s+/g, " ").trim();
  return text.length > 200 ? `${text.slice(0, 199)}…` : text;
}

function fence(value: unknown): string {
  return ["```json", JSON.stringify(value, null, 2), "```"].join("\n");
}

/** Render a session as Markdown. Empty sessions still get a header. */
export function renderSessionMarkdown(
  sessionId: string,
  meta: ChatSessionMeta,
  events: readonly TranscriptEvent[],
): string {
  const title = meta.title?.trim() || "Untitled session";
  const createdAt = events[0]?.time;
  const updatedAt = events.at(-1)?.time;
  const lines: string[] = [
    `# ${title}`,
    "",
    `- Session: \`${sessionId}\``,
    `- Project: \`${meta.projectId ?? "—"}\``,
    `- Model: \`${meta.providerId ?? "—"}/${meta.modelId ?? "—"}\``,
    `- Permission: \`${meta.permissionMode ?? "—"}\``,
  ];
  if (createdAt !== undefined) lines.push(`- Created: ${iso(createdAt)}`);
  if (updatedAt !== undefined) lines.push(`- Updated: ${iso(updatedAt)}`);
  lines.push("");

  let turn: number | undefined;
  let section: string[] = [];
  const flush = (): void => {
    if (section.length === 0) return;
    lines.push(...section, "");
    section = [];
  };

  for (const event of events) {
    if (event.type === "turn_start") {
      flush();
      turn = (event.data as { turn?: number }).turn ?? turn;
      lines.push(`## Turn ${turn ?? "?"}`, "");
      continue;
    }
    if (event.type === "user_message") {
      const text = contentText((event.data as { content?: unknown }).content);
      if (text !== "") section.push("### User", "", text, "");
      continue;
    }
    if (event.type === "assistant_message") {
      const text = contentText((event.data as { content?: unknown }).content);
      if (text !== "") section.push("### Assistant", "", text, "");
      continue;
    }
    if (event.type === "tool_call") {
      const data = event.data as { name?: string; input?: unknown };
      section.push(`### Tool \`${data.name ?? "unknown"}\``, "", fence(data.input ?? {}), "");
      continue;
    }
    if (event.type === "tool_result") {
      const data = event.data as { content?: unknown; isError?: boolean };
      const summary = toolResultSummary(data.content);
      section.push(`→ ${data.isError === true ? "error" : "ok"}${summary ? `: ${summary}` : ""}`, "");
      continue;
    }
    if (event.type === "turn_end") {
      flush();
      continue;
    }
  }
  flush();
  return lines.join("\n").replace(/\n{3,}/g, "\n\n").trimEnd() + "\n";
}

/** Render a session as v2 JSONL: one object per line, session_meta first. */
export function renderSessionJsonl(
  sessionId: string,
  events: readonly TranscriptEvent[],
): string {
  return (
    events
      .map((event) => JSON.stringify({ version: 3, sessionId, event }))
      .join("\n") + "\n"
  );
}
