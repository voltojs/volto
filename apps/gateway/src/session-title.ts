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

import type {
  AgentInput,
  ContentBlock,
  ModelPort,
  ModelRequest,
  TranscriptEvent,
} from "@volto/core";
import { projectMessages } from "@volto/core";

/**
 * A derived title is the first user message collapsed to one line, capped
 * here. Early builds clipped at 30 code points, which made a header read
 * "review 从 29cd234…"; 60 keeps a short real prompt whole without turning a
 * pasted essay into a header. Manual renames keep their own, larger limit in
 * the server route.
 */
const MAX_HEURISTIC_TITLE_LENGTH = 60;

/**
 * A model-written title is a name, not a reply. Anything longer than this is
 * refused outright rather than clipped: clipping a reply fabricates a title
 * the model never meant, and the heuristic title is the better fallback.
 */
const MAX_MODEL_TITLE_CODEPOINTS = 40;

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
  return codepoints.length > MAX_HEURISTIC_TITLE_LENGTH
    ? `${codepoints.slice(0, MAX_HEURISTIC_TITLE_LENGTH).join("")}…`
    : collapsed;
}

/**
 * The text of one message's content, or null when it carries no text.
 *
 * Only text blocks contribute: a message that also holds attachments must be
 * named after what the user wrote, not after the attachment.
 */
function contentText(content: string | ContentBlock[]): string | null {
  if (typeof content === "string") return content.length > 0 ? content : null;
  const text = content
    .filter((block): block is { type: "text"; text: string } => block.type === "text")
    .map((block) => block.text)
    .join(" ")
    .trim();
  return text.length > 0 ? text : null;
}

/**
 * The text of the first user message in a transcript, or null when the log
 * has none yet.
 *
 * Reads the projected message list rather than walking events, so a message
 * that arrived as content blocks (text + attachments) projects the same way
 * the conversation view does.
 */
export function firstUserMessageText(events: readonly TranscriptEvent[]): string | null {
  const first = projectMessages(events).find((message) => message.role === "user");
  return first ? contentText(first.content) : null;
}

/**
 * The text of the message a turn was started with, or null when it is not a
 * user message.
 *
 * `POST /messages` passes a plain string unless the message carries
 * attachments, in which case it becomes a `user_message` input holding the
 * text next to the attachment blocks — so the first turn's own message has to
 * be read the same way the transcript is read.
 */
export function messageText(message: string | AgentInput): string | null {
  if (typeof message === "string") return message;
  if (message.type !== "user_message") return null;
  return contentText(message.content);
}
/**
 * How long a title request may take. A title that is not worth waiting 15
 * seconds for is not worth keeping a request open for either: on timeout the
 * heuristic title simply stays.
 */
export const TITLE_TIMEOUT_MS = 15_000;

/**
 * Tells the model what a title is. The instruction travels inside the user
 * message: models such as MiMo answer a message that carries only a bare
 * system instruction instead of naming it (observed live), while the same
 * instruction placed next to the text produces a title.
 */
const TITLE_INSTRUCTION = [
  "Name the conversation below with a short title.",
  "Reply with the title only: no quotes, no markdown, no trailing punctuation.",
  "One line, at most 12 Chinese characters or 8 English words.",
  "Write it in the same language as the conversation.",
].join(" ");

/** Cap on the conversation text sent to the title model, in codepoints. */
const MAX_PROMPT_INPUT = 2_000;

/** The user message that carries both the instruction and the conversation. */
function titleRequestText(firstUserMessage: string): string {
  const conversation = Array.from(firstUserMessage).slice(0, MAX_PROMPT_INPUT).join("");
  return [TITLE_INSTRUCTION, "", "<conversation>", conversation, "</conversation>"].join("\n");
}

/**
 * Cleans a model's raw answer into a usable title, or null when the answer is
 * not a title at all.
 *
 * Models wrap short answers in quotes, backticks, or a markdown fence, and
 * some append a period; none of that belongs in a sidebar row. A model that
 * treats the request as a conversation produces a reply (multi-line, long, or
 * marked up); the heuristic title is the better name, so such an answer is
 * refused instead of clipped or flattened.
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
  // A reply uses several lines; a title is one.
  if (title.split(/\r?\n/u).filter((line) => line.trim().length > 0).length > 1) return null;
  // One line, no runs of whitespace.
  title = title.replace(/\s+/gu, " ").trim();
  // Trailing sentence punctuation reads as a sentence, not a name.
  title = title.replace(/[。．.，,；;：:！!？?、]+$/u, "").trim();
  if (title.length === 0) return null;
  // Nothing but punctuation left over: not a title.
  if (!/[\p{L}\p{N}]/u.test(title)) return null;
  // Markdown headings, list items, leftover fences, and an odd backtick count
  // all signal a reply rather than a name.
  if (title.startsWith("#")) return null;
  if (/^[-*+]\s/u.test(title)) return null;
  if (title.includes("```")) return null;
  if ((title.match(/`/gu)?.length ?? 0) % 2 === 1) return null;
  // Tool-call markup leaked into text (the model answering with a planned
  // tool call instead of a title).
  if (/<(?:tool_call|function|parameter|\/)/iu.test(title)) return null;
  // Longer than a name: refused, never clipped.
  if (Array.from(title).length > MAX_MODEL_TITLE_CODEPOINTS) return null;
  return title;
}

/**
 * Asks `port` to name a conversation, resolving to a cleaned title.
 *
 * Every failure mode is the same answer — null, meaning "keep whatever title
 * the session already has": a provider error, a timeout (the abort signal
 * reaches the port's request), an empty answer, an answer that is only
 * punctuation, a reply too long or too structured to be a name, or an answer
 * cut off by the output-token cap. A title is decoration; it never surfaces
 * an error to the conversation.
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
        { id: "title-user", role: "user", content: titleRequestText(firstUserMessage) },
      ],
      tools: [],
      model,
      // A title is a few words; a larger ceiling avoids cutting a legitimate
      // title mid-word, and a truncated reply is rejected below anyway.
      maxTokens: 256,
      abortSignal: controller.signal,
    };

    let text = "";
    let finish: "end_turn" | "tool_use" | "max_tokens" | undefined;
    for await (const event of port.stream(request)) {
      // A port that ignores its abort signal must not be able to answer after
      // the deadline: the bound is the generator's to enforce, not the
      // provider's to honour.
      if (controller.signal.aborted) return null;
      if (event.type === "text_delta") text += event.text;
      else if (event.type === "done") finish = event.stopReason;
      else if (event.type === "error") return null;
    }
    if (controller.signal.aborted) return null;
    // A cut-off answer is not a title, even when it fits the length check:
    // its tail is arbitrary.
    if (finish === "max_tokens") return null;
    return sanitizeGeneratedTitle(text);
  } catch {
    // Aborts and provider failures are both "no title this time".
    return null;
  } finally {
    clearTimeout(timer);
  }
}
