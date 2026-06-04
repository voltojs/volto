import { describe, it, expect } from "vitest";
import { createRenderingEventSink } from "../render.js";

describe("reference CLI renderer", () => {
  it("writes plain text_delta from the main agent directly to stdout", () => {
    const stdout: string[] = [];
    const sink = createRenderingEventSink({ stdout: (s) => stdout.push(s) });

    sink.emit({ type: "text_delta", data: { text: "Hello, world!" } });
    sink.emit({ type: "model_done", data: {} });

    expect(stdout.join("")).toBe("Hello, world!\n");
  });

  it("brackets sub-agent text with a depth label and closes on main resumption", () => {
    const stdout: string[] = [];
    const sink = createRenderingEventSink({ stdout: (s) => stdout.push(s) });

    sink.emit({ type: "text_delta", data: { text: "main begin " } });
    sink.emit({
      type: "text_delta",
      data: { text: "sub speaks", agentDepth: 1, agentLabel: "task" },
    });
    sink.emit({ type: "text_delta", data: { text: "main continues" } });
    sink.emit({ type: "model_done", data: {} });

    const out = stdout.join("");
    expect(out).toContain("main begin ");
    expect(out).toContain("[task (depth=1)]");
    expect(out).toContain("sub speaks");
    expect(out).toContain("[/depth=1]");
    expect(out).toContain("main continues");
    // Sub-agent block must be opened before its text and closed before main continues.
    const openIdx = out.indexOf("[task (depth=1)]");
    const subIdx = out.indexOf("sub speaks");
    const closeIdx = out.indexOf("[/depth=1]");
    const mainAfterIdx = out.indexOf("main continues");
    expect(openIdx).toBeLessThan(subIdx);
    expect(subIdx).toBeLessThan(closeIdx);
    expect(closeIdx).toBeLessThan(mainAfterIdx);
  });
});
