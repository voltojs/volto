/**
 * ToolTracer
 * 按 toolCallId 聚合 tool_use_complete + tool_result 事件，展示完整调用链。
 *
 * 数据源：当前 cursor 截取的可见事件流（来自 debug-store）。两类事件用
 * `toolCallId` 关联：
 *   - tool_use_complete: { id, name, args, depth? }
 *   - tool_result:       { toolCallId, result?, error?, durationMs? }
 *
 * 显示：每条工具调用作为一张卡片，含名称、参数、结果或错误、耗时；缺一项时
 * 状态显示为"调用中"。
 */

import { useMemo, useState } from "react";
import { ChevronRight } from "lucide-react";
import { Badge } from "@/renderer/src/components/ui/badge";
import { useDebugStore, type DebugEvent } from "@/renderer/src/stores/debug-store";
import { cn } from "@/renderer/src/lib/utils";

interface ToolTrace {
  toolCallId: string;
  name?: string;
  args?: Record<string, unknown>;
  result?: unknown;
  error?: string;
  durationMs?: number;
  startSeq: number;
  endSeq?: number;
  startedAt?: number;
  finishedAt?: number;
}

function aggregate(events: DebugEvent[]): ToolTrace[] {
  const byId = new Map<string, ToolTrace>();
  const order: string[] = [];
  for (const e of events) {
    if (e.type === "tool_use_complete") {
      const id =
        (typeof e.data["id"] === "string" && (e.data["id"] as string)) ||
        (typeof e.data["toolCallId"] === "string" && (e.data["toolCallId"] as string)) ||
        "";
      if (!id) continue;
      const trace: ToolTrace = byId.get(id) ?? {
        toolCallId: id,
        startSeq: e.seq,
        startedAt: e.timestamp,
      };
      trace.name = typeof e.data["name"] === "string" ? (e.data["name"] as string) : trace.name;
      trace.args =
        (e.data["args"] as Record<string, unknown> | undefined) ?? trace.args;
      if (!byId.has(id)) {
        byId.set(id, trace);
        order.push(id);
      }
    } else if (e.type === "tool_result") {
      const id = typeof e.data["toolCallId"] === "string" ? (e.data["toolCallId"] as string) : "";
      if (!id) continue;
      const trace: ToolTrace = byId.get(id) ?? {
        toolCallId: id,
        startSeq: e.seq,
        startedAt: e.timestamp,
      };
      trace.result = e.data["result"];
      const err = e.data["error"];
      trace.error = typeof err === "string" ? err : undefined;
      const d = e.data["durationMs"];
      trace.durationMs = typeof d === "number" ? d : trace.durationMs;
      trace.endSeq = e.seq;
      trace.finishedAt = e.timestamp;
      if (!byId.has(id)) {
        byId.set(id, trace);
        order.push(id);
      }
    }
  }
  return order.map((id) => byId.get(id)!).filter(Boolean);
}

function truncate(s: string, max: number): string {
  return s.length > max ? s.slice(0, max) + "…" : s;
}

function formatJson(value: unknown): string {
  try {
    const json = JSON.stringify(value, null, 2);
    return truncate(json, 2000);
  } catch {
    return String(value);
  }
}

function TraceCard({ trace }: { trace: ToolTrace }) {
  const [open, setOpen] = useState(false);
  const pending = trace.endSeq === undefined;
  const failed = trace.error !== undefined;

  return (
    <div className="border rounded-md">
      <button
        type="button"
        className="w-full flex items-center gap-2 p-2 hover:bg-muted/40 text-left"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
      >
        <ChevronRight
          className={cn("h-3.5 w-3.5 transition-transform", open && "rotate-90")}
        />
        <span className="font-mono font-semibold text-sm">
          {trace.name ?? "(unknown)"}
        </span>
        <span className="text-xs text-muted-foreground font-mono truncate">
          {trace.toolCallId}
        </span>
        <div className="ml-auto flex items-center gap-1 shrink-0">
          {pending && <Badge variant="secondary">调用中</Badge>}
          {!pending && !failed && <Badge variant="default">成功</Badge>}
          {failed && <Badge variant="destructive">失败</Badge>}
          {trace.durationMs !== undefined && (
            <span className="text-xs text-amber-600 dark:text-amber-400 font-mono">
              {trace.durationMs}ms
            </span>
          )}
        </div>
      </button>

      {open && (
        <div className="border-t p-2 space-y-2 text-xs">
          <section>
            <div className="text-muted-foreground font-medium mb-1">参数</div>
            <pre className="font-mono whitespace-pre-wrap break-all bg-muted/40 rounded p-2 max-h-48 overflow-auto">
              {trace.args ? formatJson(trace.args) : "(无)"}
            </pre>
          </section>
          {!pending && (
            <section>
              <div className="text-muted-foreground font-medium mb-1">
                {failed ? "错误" : "结果"}
              </div>
              <pre
                className={cn(
                  "font-mono whitespace-pre-wrap break-all rounded p-2 max-h-48 overflow-auto",
                  failed
                    ? "bg-destructive/10 text-destructive"
                    : "bg-muted/40",
                )}
              >
                {failed
                  ? trace.error
                  : trace.result !== undefined
                    ? formatJson(trace.result)
                    : "(无)"}
              </pre>
            </section>
          )}
        </div>
      )}
    </div>
  );
}

export function ToolTracer() {
  const events = useDebugStore((s) => s.events);
  const cursor = useDebugStore((s) => s.cursor);
  const getVisibleEvents = useDebugStore((s) => s.getVisibleEvents);

  const traces = useMemo(() => {
    const visible = getVisibleEvents();
    return aggregate(visible);
  }, [events, cursor, getVisibleEvents]);

  if (traces.length === 0) {
    return (
      <div className="text-muted-foreground text-sm p-3">
        当前事件窗口内尚无工具调用。
      </div>
    );
  }

  return (
    <div className="space-y-2">
      {traces.map((t) => (
        <TraceCard key={t.toolCallId} trace={t} />
      ))}
    </div>
  );
}
