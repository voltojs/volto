/**
 * In-memory Telemetry implementation for testing.
 * Records all spans and metrics for later assertion.
 */

import type { Telemetry, TelemetrySpan } from "@voltojs/core";

export interface RecordedSpan {
  name: string;
  attributes: Record<string, unknown>;
  endedAt: number;
}

export interface RecordedMetric {
  name: string;
  value: number;
  attributes: Record<string, unknown>;
}

export class InMemoryTelemetry implements Telemetry {
  readonly spans: RecordedSpan[] = [];
  readonly metrics: RecordedMetric[] = [];
  private readonly active = new Map<TelemetrySpan, RecordedSpan>();

  startSpan(name: string, attributes?: Record<string, unknown>): TelemetrySpan {
    const span: RecordedSpan = {
      name,
      attributes: attributes ? { ...attributes } : {},
      endedAt: 0,
    };
    const handle: TelemetrySpan = {
      setAttribute: (key: string, value: unknown) => {
        span.attributes[key] = value;
      },
      end: () => {
        span.endedAt = Date.now();
        this.spans.push(span);
        this.active.delete(handle);
      },
    };
    this.active.set(handle, span);
    return handle;
  }

  metric(name: string, value: number, attributes?: Record<string, unknown>): void {
    this.metrics.push({
      name,
      value,
      attributes: attributes ? { ...attributes } : {},
    });
  }

  get activeSpanCount(): number {
    return this.active.size;
  }
}
