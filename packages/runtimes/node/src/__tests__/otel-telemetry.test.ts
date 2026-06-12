import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createOtelTelemetry } from "../otel-telemetry.js";

describe("createOtelTelemetry", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("records spans and flushes on end", async () => {
    const fetchSpy = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal("fetch", fetchSpy);

    const tel = createOtelTelemetry({ endpoint: "http://localhost:4318", batchSize: 1 });
    const span = tel.startSpan("test_span", { key: "value" });
    span.setAttribute("extra", 42);
    span.end();

    expect(fetchSpy).toHaveBeenCalled();
    const call = fetchSpy.mock.calls[0]!;
    const body = JSON.parse((call[1] as { body: string }).body);
    expect(body.traces).toBeDefined();
    expect(body.traces.resourceSpans[0]!.scopeSpans[0]!.spans[0]!.name).toBe("test_span");

    vi.unstubAllGlobals();
  });

  it("aggregates metrics by name", async () => {
    const fetchSpy = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal("fetch", fetchSpy);

    const tel = createOtelTelemetry({ endpoint: "http://localhost:4318", batchSize: 10 });
    tel.metric("tokens", 100, { kind: "input" });
    tel.metric("tokens", 200, { kind: "input" });
    tel.metric("cost_usd", 0.01);

    await tel.flush();

    const call2 = fetchSpy.mock.calls[0]!;
    const body2 = JSON.parse((call2[1] as { body: string }).body);
    expect(body2.metrics).toBeDefined();
    const metrics = body2.metrics.resourceMetrics[0]!.scopeMetrics[0]!.metrics;
    expect(metrics.length).toBe(2);

    vi.unstubAllGlobals();
  });

  it("shutdown flushes remaining data and stops timer", async () => {
    const fetchSpy = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal("fetch", fetchSpy);

    const tel = createOtelTelemetry({ endpoint: "http://localhost:4318", batchSize: 100, flushIntervalMs: 1000 });
    tel.metric("test", 1);

    await tel.shutdown();

    expect(fetchSpy).toHaveBeenCalled();
    vi.unstubAllGlobals();
  });
});
