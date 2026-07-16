/**
 * EventTimeline
 * 按时间顺序展示 EventSink 事件流；对工具调用类事件渲染 duration 条形图。
 *
 * 数据源：`useDebugStore.getVisibleEvents()`（已应用 cursor 与 filter）。
 * Duration 来源：`event.data.durationMs`（runner 已 stamp 到 `displayMetadata`，
 * 经 EventBridge 透传），缺失时不画条形。
 */

import { useMemo } from "react";
import { useDebugStore, type DebugEvent } from "@/renderer/src/stores/debug-store";
import { cn } from "@/renderer/src/lib/utils";

/** 把事件按视觉类别分组，决定颜色 */
function classifyEvent(type: string): "text" | "tool" | "error" | "lifecycle" | "other" {
  if (type === "text_delta" || type === "reasoning_delta") return "text";
  if (type === "tool_use_complete" || type === "tool_result") return "tool";
  if (type === "error") return "error";
  if (
    type === "model_done" ||
    type === "user_message" ||
    type === "cancelled" ||
    type === "budget_exceeded" ||
    type === "model_retry"
  ) {
    return "lifecycle";
  }
  return "other";
}

const CATEGORY_STYLE: Record<ReturnType<typeof classifyEvent>, string> = {
  text: "border-l-blue-400",
  tool: "border-l-amber-500",
  error: "border-l-red-500",
  lifecycle: "border-l-emerald-500",
  other: "border-l-muted-foreground",
};

function fmtTime(ts: number, base: number): string {
  const delta = ts - base;
  if (delta < 1000) return `+${delta}ms`;
  return `+${(delta / 1000).toFixed(2)}s`;
}

function readDurationMs(event: DebugEvent): number | undefined {
  const ms = event.data["durationMs"];
  return typeof ms === "number" ? ms : undefined;
}

function previewData(event: DebugEvent): string {
  if (event.type === "text_delta") {
    const t = event.data["text"];
    return typeof t === "string" ? t.slice(0, 64) : "";
  }
  if (event.type === "tool_use_complete") {
    const name = event.data["name"];
    return typeof name === "string" ? name : "";
  }
  if (event.type === "tool_result") {
    const id = event.data["toolCallId"];
    const hasErr = "error" in event.data && event.data["error"] != null;
    return `${typeof id === "string" ? id : ""}${hasErr ? " ✗" : " ✓"}`;
  }
  if (event.type === "error") {
    const err = event.data["error"];
    return typeof err === "string" ? err.slice(0, 64) : "";
  }
  try {
    return JSON.stringify(event.data).slice(0, 80);
  } catch {
    return "";
  }
}

export function EventTimeline() {
  // 订阅 events / cursor / filter；getVisibleEvents() 内部按这三者做切片+过滤
  const events = useDebugStore((s) => s.events);
  const cursor = useDebugStore((s) => s.cursor);
  const filter = useDebugStore((s) => s.filter);
  const getVisibleEvents = useDebugStore((s) => s.getVisibleEvents);

  const visible = useMemo(
    () => getVisibleEvents(),
    // events/cursor/filter 任一变化都需要重算
    [events, cursor, filter, getVisibleEvents],
  );

  const baseTs = visible[0]?.timestamp ?? Date.now();
  const maxDuration = useMemo(() => {
    let max = 0;
    for (const e of visible) {
      const d = readDurationMs(e);
      if (d && d > max) max = d;
    }
    return Math.max(max, 1);
  }, [visible]);

  if (visible.length === 0) {
    return (
      <div className="text-muted-foreground text-sm p-3">
        暂无事件。发送一条消息后这里会按时间顺序列出 EventSink 推送的事件。
      </div>
    );
  }

  return (
    <div className="space-y-1 font-mono text-xs">
      {visible.map((event) => {
        const cat = classifyEvent(event.type);
        const duration = readDurationMs(event);
        const barWidth = duration ? `${Math.min(100, (duration / maxDuration) * 100)}%` : 0;
        return (
          <div
            key={event.seq}
            className={cn(
              "border-l-2 pl-2 py-1 hover:bg-muted/40 rounded-r",
              CATEGORY_STYLE[cat],
            )}
          >
            <div className="flex items-baseline gap-2">
              <span className="text-muted-foreground w-16 shrink-0">
                {fmtTime(event.timestamp, baseTs)}
              </span>
              <span className="font-semibold w-40 shrink-0 truncate">{event.type}</span>
              <span className="text-muted-foreground truncate">{previewData(event)}</span>
              {duration !== undefined && (
                <span className="ml-auto text-amber-600 dark:text-amber-400 shrink-0">
                  {duration}ms
                </span>
              )}
            </div>
            {duration !== undefined && (
              <div className="ml-[4.5rem] mt-1 h-1 bg-muted rounded">
                <div
                  className="h-1 bg-amber-500/70 rounded"
                  style={{ width: barWidth }}
                />
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
