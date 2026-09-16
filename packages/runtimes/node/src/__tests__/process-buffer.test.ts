import { describe, it, expect } from "vitest";
import {
  createProcessOutputBuffer,
  DEFAULT_PROCESS_BUFFER_BYTES,
} from "../process-buffer.js";

describe("process output ring buffer", () => {
  it("defaults to 256 KiB capacity", () => {
    expect(DEFAULT_PROCESS_BUFFER_BYTES).toBe(256 * 1024);
  });

  it("returns everything when under capacity and cursor is omitted", () => {
    const buf = createProcessOutputBuffer(1024);
    buf.append("hello ");
    buf.append("world");
    const r = buf.read();
    expect(r.text).toBe("hello world");
    expect(r.overflowed).toBe(false);
    expect(r.droppedBytes).toBe(0);
  });

  it("second read from previous cursor returns empty, not a repeat", () => {
    const buf = createProcessOutputBuffer(1024);
    buf.append("abc");
    const first = buf.read();
    buf.append("def");
    const second = buf.read(first.cursor);
    expect(second.text).toBe("def");
    const third = buf.read(second.cursor);
    expect(third.text).toBe("");
  });

  it("evicts the oldest data once over capacity and reports dropped bytes", () => {
    const buf = createProcessOutputBuffer(10);
    buf.append("aaaaaaaaaa"); // exactly 10
    buf.append("bbbbbbbbbb"); // evicts first 10
    const r = buf.read();
    expect(r.overflowed).toBe(true);
    expect(r.droppedBytes).toBe(10);
    expect(r.text).toBe("bbbbbbbbbb");
    expect(r.text).not.toContain("a");
  });

  it("prefixes overflowed reads with a discard note", () => {
    const buf = createProcessOutputBuffer(8);
    buf.append("0123456789ABCDEF");
    const r = buf.read();
    expect(r.overflowed).toBe(true);
    expect(r.text).toContain("更早的输出已丢弃");
    expect(r.text).toContain(String(r.droppedBytes));
  });

  it("keeps a single oversized chunk's tail", () => {
    const buf = createProcessOutputBuffer(4);
    buf.append("XXXXXXXXYYYY");
    const r = buf.read();
    expect(r.overflowed).toBe(true);
    expect(r.text.endsWith("YYYY")).toBe(true);
    expect(r.droppedBytes).toBe(8);
  });
});
