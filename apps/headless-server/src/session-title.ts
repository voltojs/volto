/**
 * Session titles.
 *
 * The gateway owns naming: it derives a title from the first user message
 * before the first turn starts (so the client never shows an untitled
 * conversation), and later replaces it with a generated one when the user has
 * configured a title model. Both writes go through the registry's ranked
 * writer, so a title a human typed always wins.
 *
 * Nothing here reads the clock or the network on its own except
 * `generateTitle`, which takes an already-built `ModelPort` — the host owns
 * provider resolution.
 */

import type { ModelPort, ModelRequest, TranscriptEvent } from "@volto/core";
import { projectMessages } from "@volto/core";

/**
 * A derived title is the first user message collapsed to one line, capped
 * here. Early builds clipped at 30 code points, which made a header read
 * "review 从 29cd234…"; the cap is generous enough to keep a real title whole
 * while still refusing to turn a pasted essay into a header. The server
 * enforces the same 200 on every manual rename.
 */
const MAX_TITLE_LENGTH = 200;

/**
 * Collapses the first user message to a single line and caps it.
 *
 * Returns null for blank input — callers use that to mean "nothing to name
 * this session with yet". Truncation counts Unicode codepoints (via
 * `Array.from`) rather than UTF-16 code units so a title never gets cut
 * through the middle of a surrogate pair.
 */
export function deriveHeuristicTitle(firstUserMessage: string): string | null {
  const collapsed = firstUserMessage.replace(/\s+/g, " ").trim();
  if (collapsed.length === 0) return null;

  const codepoints = Array.from(collapsed);
  return codepoints.length > MAX_TITLE_LENGTH
    ? `${codepoints.slice(0, MAX_TITLE_LENGTH).join("")}…`
    : collapsed;
}

/**
 * The text of the first user message in a transcript, or null when the log
 * has none yet.
 *
 * Reads the projected message list rather than walking events, so a message
 * that arrived as content blocks (text + attachments) projects the same way
 * the conversation view does. Only text blocks contribute — an attachment's
 * filename is not the session's subject.
 */
export function firstUserMessageText(events: readonly TranscriptEvent[]): string | null {
  const first = projectMessages(events).find((message) => message.role === "user");
  if (!first) return null;
  const content = first.content;
  if (typeof content === "string") return content.length > 0 ? content : null;
  const text = content
    .filter((block): block is { type: "text"; text: string } => block.type === "text")
    .map((block) => block.text)
    .join(" ")
    .trim();
  return text.length > 0 ? text : null;
}
/**
 * How long a title request may take. A title that is not worth waiting 15
 * seconds for is not worth keeping a request open for either: on timeout the
 * heuristic title simply stays.
 */
export const TITLE_TIMEOUT_MS = 15_000;

/**
 * Tells the model what a title is. Deliberately short: this is a cheap
 * utility call, not a conversation, and the output is discarded unless it
 * survives `sanitizeGeneratedTitle`.
 */
const TITLE_SYSTEM_PROMPT = [
  "You name conversations for a coding assistant.",
  "Reply with the title only: no quotes, no markdown, no trailing punctuation.",
  "One line, at most 12 Chinese characters or 8 English words.",
  "Write it in the same language as the user's message.",
].join(" ");

/** Cap on the user message sent to the title model, in codepoints. */
const MAX_PROMPT_INPUT = 2_000;

/**
 * Cleans a model's raw answer into a usable title.
 *
 * Models wrap short answers in quotes, backticks, or a markdown fence, and
 * some append a period; none of that belongs in a sidebar row. Returns null
 * when nothing usable is left, which the caller reads as "keep the current
 * title".
 */
export function sanitizeGeneratedTitle(raw: string): string | null {
  let title = raw.trim();
  // A fenced answer: keep whatever is inside the fence.
  title = title.replace(/^```[^\n]*\n?/u, "").replace(/\n?```$/u, "").trim();
  // Quotes / backticks wrapping the whole answer, possibly repeated.
  for (let i = 0; i < 2; i += 1) {
    const previous = title;
    title = title.replace(/^["'`“”‘’「」『』]+/u, "").replace(/["'`“”‘’「」『』]+$/u, "");
    if (title === previous) break;
  }
  // One line, no runs of whitespace.
  title = title.replace(/\s+/gu, " ").trim();
  // Trailing sentence punctuation reads as a sentence, not a name.
  title = title.replace(/[。．.，,；;：:！!？?、]+$/u, "").trim();
  if (title.length === 0) return null;
  // Nothing but punctuation left over: not a title.
  if (!/[\p{L}\p{N}]/u.test(title)) return null;

  const codepoints = Array.from(title);
  return codepoints.length > MAX_TITLE_LENGTH
    ? codepoints.slice(0, MAX_TITLE_LENGTH).join("")
    : title;
}

/**
 * Asks `port` to name a conversation, resolving to a cleaned title.
 *
 * Every failure mode is the same answer — null, meaning "keep whatever title
 * the session already has": a provider error, a timeout (the abort signal
 * reaches the port's request), an empty answer, or an answer that is only
 * punctuation. A title is decoration; it never surfaces an error to the
 * conversation.
 */
export async function generateTitle(
  port: ModelPort,
  model: string,
  firstUserMessage: string,
  timeoutMs: number = TITLE_TIMEOUT_MS,
): Promise<string | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const request: ModelRequest = {
      messages: [
        { id: "title-system", role: "system", content: TITLE_SYSTEM_PROMPT },
        {
          id: "title-user",
          role: "user",
          content: Array.from(firstUserMessage).slice(0, MAX_PROMPT_INPUT).join(""),
        },
      ],
      tools: [],
      model,
      // A title is a few words; anything longer is the model ignoring the
      // instruction, and the cap keeps a runaway answer cheap.
      maxTokens: 64,
      abortSignal: controller.signal,
    };

    let text = "";
    for await (const event of port.stream(request)) {
      if (event.type === "text_delta") text += event.text;
      else if (event.type === "error") return null;
    }
    return sanitizeGeneratedTitle(text);
  } catch {
    // Aborts and provider failures are both "no title this time".
    return null;
  } finally {
    clearTimeout(timer);
  }
}
