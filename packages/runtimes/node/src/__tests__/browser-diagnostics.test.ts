import { describe, expect, it } from "vitest";
import { createDiagnosticsBuffer } from "../browser-diagnostics.js";

const NOW = Date.UTC(2026, 0, 1, 12, 0, 0);

describe("createDiagnosticsBuffer", () => {
  it("keeps only the last N entries", () => {
    const buffer = createDiagnosticsBuffer(3, () => NOW);
    for (let i = 0; i < 5; i += 1) buffer.console("error", `e${i}`);
    const result = buffer.format("console", { limit: 10 });
    expect(result.text.split("\n")).toEqual([
      "[12:00:00] error: e2",
      "[12:00:00] error: e3",
      "[12:00:00] error: e4",
    ]);
    expect(result.truncated).toBe(false);
  });

  it("filters console levels and reports truncation", () => {
    const buffer = createDiagnosticsBuffer(10, () => NOW);
    buffer.console("error", "boom");
    buffer.console("warning", "careful");
    buffer.console("info", "hello");
    expect(buffer.format("console", { level: "error" }).text).toBe("[12:00:00] error: boom");
    const limited = buffer.format("console", { limit: 1 });
    expect(limited.truncated).toBe(true);
    expect(limited.text).toBe("[12:00:00] info: hello");
  });

  it("records network failures and 4xx/5xx without bodies", () => {
    const buffer = createDiagnosticsBuffer(10, () => NOW);
    buffer.networkFailure("GET", "http://localhost:5173/api", "net::ERR_CONNECTION_REFUSED");
    buffer.networkStatus(500, "POST", "http://localhost:5173/api/login");
    const result = buffer.format("network", { limit: 10 });
    expect(result.text).toContain("failed GET http://localhost:5173/api: net::ERR_CONNECTION_REFUSED");
    expect(result.text).toContain("500 POST http://localhost:5173/api/login");
    expect(result.text).not.toContain("body");
  });

  it("returns an empty string when nothing was recorded", () => {
    const buffer = createDiagnosticsBuffer();
    expect(buffer.format("console", {})).toEqual({ text: "", truncated: false });
    expect(buffer.format("network", {})).toEqual({ text: "", truncated: false });
  });
});