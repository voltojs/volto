/**
 * LogViewer
 * 把全部 EventSink 事件作为结构化日志展示，支持按事件类型多选过滤、关键字
 * 搜索（filter 由 debug-store 持有，与其它面板共享）、单条展开查看 JSON 详情。
 *
 * 与 EventTimeline 的区别：Timeline 是时间轴视觉化（带 duration 条形图、
 * 时间偏移），LogViewer 更像 console — 列表 + JSON 详情，便于按字段定位。
 */

import { useMemo, useState } from "react";
import { Search, X, ChevronRight } from "lucide-react";
import { Badge } from "@/renderer/src/components/ui/badge";
import { Button } from "@/renderer/src/components/ui/button";
import { Input } from "@/renderer/src/components/ui/input";
import { useDebugStore, type DebugEvent } from "@/renderer/src/stores/debug-store";
import { cn } from "@/renderer/src/lib/utils";

/** 与 EventTimeline 共享的事件类别 → 颜色映射 */
function categoryOf(type: string): "text" | "tool" | "error" | "lifecycle" | "other" {
  if (type === "text_delta" || type === "reasoning_delta") return "text";
  if (type === "tool_use_complete" || type === "tool_result") return "tool";
  if (type === "error") return "error";
  if (
    type === "model_done" ||
    type === "user_message" ||
    type === "cancelled" ||
    type === "budget_exceeded" ||
    type === "model_retry"
  )
    return "lifecycle";
  return "other";
}

const CATEGORY_LABEL: Record<ReturnType<typeof categoryOf>, string> = {
  text: "文本",
  tool: "工具",
  error: "错误",
  lifecycle: "生命周期",
  other: "其它",
};

const CATEGORY_BADGE: Record<
  ReturnType<typeof categoryOf>,
  "default" | "secondary" | "destructive"
> = {
  text: "default",
  tool: "default",
  error: "destructive",
  lifecycle: "secondary",
  other: "secondary",
};

function fmtAbsTime(ts: number): string {
  const d = new Date(ts);
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  const ss = String(d.getSeconds()).padStart(2, "0");
  const ms = String(d.getMilliseconds()).padStart(3, "0");
  return `${hh}:${mm}:${ss}.${ms}`;
}

function LogRow({ event }: { event: DebugEvent }) {
  const [open, setOpen] = useState(false);
  const cat = categoryOf(event.type);
  return (
    <div className="border-b last:border-b-0">
      <button
        type="button"
        className="w-full grid grid-cols-[1rem_auto_8rem_auto_1fr] items-center gap-2 px-2 py-1 text-left hover:bg-muted/40 font-mono text-xs"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
      >
        <ChevronRight
          className={cn("h-3 w-3 text-muted-foreground transition-transform", open && "rotate-90")}
        />
        <span className="text-muted-foreground">{fmtAbsTime(event.timestamp)}</span>
        <span className="truncate">{event.type}</span>
        <Badge variant={CATEGORY_BADGE[cat]} className="ml-1">
          {CATEGORY_LABEL[cat]}
        </Badge>
        <span className="text-muted-foreground truncate">
          {(() => {
            try {
              return JSON.stringify(event.data).slice(0, 120);
            } catch {
              return "";
            }
          })()}
        </span>
      </button>
      {open && (
        <pre className="font-mono text-xs whitespace-pre-wrap break-all bg-muted/40 m-2 p-2 rounded max-h-64 overflow-auto">
          {JSON.stringify(event, null, 2)}
        </pre>
      )}
    </div>
  );
}

const ALL_CATS: Array<ReturnType<typeof categoryOf>> = [
  "text",
  "tool",
  "error",
  "lifecycle",
  "other",
];

export function LogViewer() {
  const events = useDebugStore((s) => s.events);
  const cursor = useDebugStore((s) => s.cursor);
  const filter = useDebugStore((s) => s.filter);
  const setFilter = useDebugStore((s) => s.setFilter);
  const getVisibleEvents = useDebugStore((s) => s.getVisibleEvents);

  const [enabledCats, setEnabledCats] = useState<Set<ReturnType<typeof categoryOf>>>(
    () => new Set(ALL_CATS),
  );

  const toggleCat = (cat: ReturnType<typeof categoryOf>) => {
    setEnabledCats((prev) => {
      const next = new Set(prev);
      if (next.has(cat)) next.delete(cat);
      else next.add(cat);
      return next;
    });
  };

  const visible = useMemo(() => {
    const sliced = getVisibleEvents();
    return sliced.filter((e) => enabledCats.has(categoryOf(e.type)));
  }, [events, cursor, filter, enabledCats, getVisibleEvents]);

  return (
    <div className="flex flex-col h-full gap-2">
      <div className="flex items-center gap-2">
        <div className="relative flex-1">
          <Search className="absolute left-2 top-1/2 -translate-y-1/2 h-3 w-3 text-muted-foreground" />
          <Input
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            placeholder="搜索事件 type 或 JSON data"
            className="h-8 pl-7"
          />
          {filter && (
            <button
              type="button"
              onClick={() => setFilter("")}
              aria-label="清除搜索"
              className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
            >
              <X className="h-3 w-3" />
            </button>
          )}
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-1">
        {ALL_CATS.map((c) => (
          <Button
            key={c}
            type="button"
            variant={enabledCats.has(c) ? "default" : "outline"}
            size="sm"
            className="h-6 px-2 text-xs"
            onClick={() => toggleCat(c)}
            aria-pressed={enabledCats.has(c)}
          >
            {CATEGORY_LABEL[c]}
          </Button>
        ))}
      </div>

      <div className="flex-1 overflow-auto rounded-md border">
        {visible.length === 0 ? (
          <div className="text-muted-foreground text-sm p-3">无匹配事件。</div>
        ) : (
          visible.map((e) => <LogRow key={e.seq} event={e} />)
        )}
      </div>

      <div className="text-xs text-muted-foreground">
        {visible.length} / {cursor} 显示，缓冲区合计 {events.length}
      </div>
    </div>
  );
}
