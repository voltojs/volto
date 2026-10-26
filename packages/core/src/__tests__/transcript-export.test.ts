import { describe, it, expect } from "vitest";
import { renderSessionJsonl, renderSessionMarkdown } from "../transcript-export.js";
import type { ChatSessionMeta, TranscriptEvent } from "../ports.js";

const meta: ChatSessionMeta = {
  title: "Debug pnpm",
  projectId: "p1",
  providerId: "prov",
  modelId: "model",
  permissionMode: "ask",
};

function e(seq: number, type: string, data: unknown, turn?: number): TranscriptEvent {
  return { seq, time: 1000 + seq, type: type as TranscriptEvent["type"], data: data as never, ...(turn !== undefined ? { turn } : {}) };
}

const events = [
  e(0, "session_meta", meta),
  e(1, "turn_start", { turn: 1 }, 1),
  e(2, "user_message", { content: "How do I install?" }, 1),
  e(3, "tool_call", { callId: "c1", name: "read_file", input: { path: "package.json" } }, 1),
  e(4, "tool_result", { callId: "c1", content: "{\"packageManager\":\"pnpm\"}", isError: false }, 1),
  e(5, "assistant_message", { content: [{ type: "reasoning", text: "secret reasoning trace" }, { type: "text", text: "Use pnpm." }], durationMs: 1 }, 1),
  e(6, "turn_end", { turn: 1, reason: "done" }, 1),
];

describe("transcript export", () => {
  it("renders Markdown with title, bindings, turns, tools and image refs", () => {
    const md = renderSessionMarkdown("s1", meta, events);
    expect(md).toContain("# Debug pnpm");
    expect(md).toContain("- Session: `s1`");
    expect(md).toContain("## Turn 1");
    expect(md).toContain("### User\n\nHow do I install?");
    expect(md).toContain("### Tool `read_file`");
    expect(md).toContain("→ ok:");
    expect(md).toContain("### Assistant\n\nUse pnpm.");
    // The input carries a reasoning block; the renderer must drop it.
    expect(md).not.toContain("secret reasoning trace");
  });

  it("preserves blank lines in message text and cuts summaries by code point", () => {
    const custom = [
      e(0, "session_meta", meta),
      e(1, "turn_start", { turn: 1 }, 1),
      e(2, "user_message", { content: "para1\n\n\n\npara2" }, 1),
      e(3, "tool_result", { callId: "c1", content: "😀".repeat(300), isError: false }, 1),
      e(4, "turn_end", { turn: 1, reason: "done" }, 1),
    ];
    const md = renderSessionMarkdown("s2", meta, custom);
    // Export fidelity: the renderer must not rewrite user text, so a run of
    // blank lines survives instead of being collapsed to one.
    expect(md).toContain("para1\n\n\n\npara2");
    // The summary is cut by code point — a naive slice would emit a lone
    // surrogate from the emoji pairs.
    expect(md).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/);
    expect(md).toContain("…");
  });

  it("renders non-numeric times and new-line titles without throwing", () => {
    const corrupt: TranscriptEvent[] = [
      { seq: 0, time: Number.NaN, type: "session_meta", data: meta },
    ];
    const md = renderSessionMarkdown("s3", { ...meta, title: "line1\nline2" }, corrupt);
    // The heading stays a single line; the corrupt time renders as "—".
    expect(md).toContain("# line1 line2");
    expect(md).toContain("- Created: —");
  });

  it("renders a valid JSONL line per event with meta first", () => {
    const jsonl = renderSessionJsonl("s1", events);
    const lines = jsonl.trimEnd().split("\n");
    expect(lines).toHaveLength(events.length);
    const first = JSON.parse(lines[0]!) as { version: number; sessionId: string; event: { type: string } };
    expect(first).toMatchObject({ version: 3, sessionId: "s1", event: { type: "session_meta" } });
    for (const line of lines) expect(() => JSON.parse(line)).not.toThrow();
  });

  it("handles an empty session", () => {
    const md = renderSessionMarkdown("empty", { ...meta, title: undefined }, []);
    expect(md).toContain("# Untitled session");
    expect(md).toContain("- Session: `empty`");
  });
});
