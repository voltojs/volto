import type { Telemetry, TelemetrySpan } from "@agent-core/core";

export interface OtelTelemetryOptions {
  endpoint: string;
  serviceName?: string;
  batchSize?: number;
  flushIntervalMs?: number;
}

interface PendingSpan {
  name: string;
  attributes: Record<string, unknown>;
  startedAt: number;
  endedAt: number;
}

interface PendingMetric {
  name: string;
  value: number;
  attributes: Record<string, unknown>;
  timestamp: number;
}

export function createOtelTelemetry(opts: OtelTelemetryOptions): Telemetry & { flush(): Promise<void>; shutdown(): Promise<void> } {
  const { endpoint, serviceName = "agent-core", batchSize = 20, flushIntervalMs = 5000 } = opts;
  const spans: PendingSpan[] = [];
  const metrics: PendingMetric[] = [];
  let flushTimer: ReturnType<typeof setInterval> | undefined;

  function startFlushTimer(): void {
    if (flushTimer !== undefined) return;
    flushTimer = setInterval(() => { void flush(); }, flushIntervalMs);
  }

  async function flush(): Promise<void> {
    const spansToSend = spans.splice(0, spans.length);
    const metricsToSend = metrics.splice(0, metrics.length);
    if (spansToSend.length === 0 && metricsToSend.length === 0) return;

    const resource = { "service.name": serviceName };
    const payload: Record<string, unknown> = {};

    if (spansToSend.length > 0) {
      payload.traces = {
        resourceSpans: [{
          resource: { attributes: resource },
          scopeSpans: [{
            scope: { name: "agent-core" },
            spans: spansToSend.map((s) => ({
              name: s.name,
              startTimeUnixNano: String(s.startedAt * 1_000_000),
              endTimeUnixNano: String(s.endedAt * 1_000_000),
              attributes: Object.entries(s.attributes).map(([k, v]) => ({
                key: k,
                value: { stringValue: String(v) },
              })),
            })),
          }],
        }],
      };
    }

    if (metricsToSend.length > 0) {
      payload.metrics = {
        resourceMetrics: [{
          resource: { attributes: resource },
          scopeMetrics: [{
            scope: { name: "agent-core" },
            metrics: aggregateMetrics(metricsToSend),
          }],
        }],
      };
    }

    try {
      await fetch(`${endpoint}/v1/metrics`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      }).catch(() => {});
    } catch {
      // Silent: telemetry export failures should not crash the agent
    }
  }

  function startSpan(name: string, attributes?: Record<string, unknown>): TelemetrySpan {
    const startedAt = Date.now();
    const spanAttrs = attributes ? { ...attributes } : {};
    return {
      setAttribute(key: string, value: unknown) {
        spanAttrs[key] = value;
      },
      end() {
        spans.push({ name, attributes: spanAttrs, startedAt, endedAt: Date.now() });
        if (spans.length >= batchSize) {
          void flush();
        }
      },
    };
  }

  function metric(name: string, value: number, attributes?: Record<string, unknown>): void {
    metrics.push({ name, value, attributes: attributes ? { ...attributes } : {}, timestamp: Date.now() });
    startFlushTimer();
    if (metrics.length >= batchSize) {
      void flush();
    }
  }

  return {
    startSpan,
    metric,
    flush,
    async shutdown() {
      if (flushTimer !== undefined) {
        clearInterval(flushTimer);
        flushTimer = undefined;
      }
      await flush();
    },
  };
}

function aggregateMetrics(metrics: PendingMetric[]): Array<Record<string, unknown>> {
  const byName = new Map<string, PendingMetric[]>();
  for (const m of metrics) {
    const key = `${m.name}:${JSON.stringify(m.attributes)}`;
    const arr = byName.get(key) ?? [];
    arr.push(m);
    byName.set(key, arr);
  }

  return [...byName.values()].map((group) => {
    const first = group[0]!;
    const sum = group.reduce((acc, m) => acc + m.value, 0);
    return {
      name: first.name,
      description: "",
      unit: "",
      sum: {
        dataPoints: [{
          asDouble: sum,
          startTimeUnixNano: String(first.timestamp * 1_000_000),
          endTimeUnixNano: String(group[group.length - 1]!.timestamp * 1_000_000),
          attributes: Object.entries(first.attributes).map(([k, v]) => ({
            key: k,
            value: { stringValue: String(v) },
          })),
        }],
      },
    };
  });
}
