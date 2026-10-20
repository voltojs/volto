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
  e(5, "assistant_message", { content: [{ type: "text", text: "Use pnpm." }], durationMs: 1 }, 1),
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
    expect(md).not.toContain("thinking");
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
