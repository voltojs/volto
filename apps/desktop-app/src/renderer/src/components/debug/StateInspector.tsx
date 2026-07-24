/**
 * StateInspector
 * 显示主进程 agent 的当前 state 快照（按需通过 `agent:get-state` 拉取）。
 *
 * 实现策略：
 * - 自己手写一个轻量 JSON 树（递归 + 折叠 + key 路径搜索高亮），避免引入 react-json-view 等重依赖
 * - 仅展示，不可编辑；编辑 state 应通过 agent 内核而非 UI
 * - 默认深度展开 1 层，更深需用户点击；大对象（>200 个 entries）一次只渲染前 200 + "..."
 */

import { useEffect, useMemo, useState } from "react";
import { RefreshCw } from "lucide-react";
import { Button } from "@/renderer/src/components/ui/button";
import { Input } from "@/renderer/src/components/ui/input";
import { useDebugStore } from "@/renderer/src/stores/debug-store";
import { useDebug } from "@/renderer/src/hooks/use-debug";
import { useChatStore } from "@/renderer/src/stores/chat-store";
import { cn } from "@/renderer/src/lib/utils";

const MAX_CHILDREN_PER_NODE = 200;

interface NodeProps {
  name: string | number;
  value: unknown;
  depth: number;
  path: string;
  needle: string;
  defaultOpen: boolean;
}

function isPlainRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function summary(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return `Array(${value.length})`;
  if (typeof value === "object") return `Object(${Object.keys(value as object).length})`;
  if (typeof value === "string") return JSON.stringify(value);
  return String(value);
}

/** 单个 JSON 节点，递归渲染 */
function JsonNode({ name, value, depth, path, needle, defaultOpen }: NodeProps) {
  const [open, setOpen] = useState(defaultOpen);
  const isContainer = Array.isArray(value) || isPlainRecord(value);
  const pathHit = needle && path.toLowerCase().includes(needle);

  const entries = useMemo(() => {
    if (!isContainer) return [] as Array<[string | number, unknown]>;
    if (Array.isArray(value)) {
      return value
        .slice(0, MAX_CHILDREN_PER_NODE)
        .map((v, i) => [i, v] as [number, unknown]);
    }
    return Object.entries(value as Record<string, unknown>).slice(
      0,
      MAX_CHILDREN_PER_NODE,
    );
  }, [value, isContainer]);

  const overflow = isContainer
    ? (Array.isArray(value) ? value.length : Object.keys(value as object).length) -
      entries.length
    : 0;

  return (
    <div className="font-mono text-xs leading-5" style={{ paddingLeft: depth === 0 ? 0 : 12 }}>
      <div className="flex items-baseline gap-1">
        {isContainer ? (
          <button
            type="button"
            onClick={() => setOpen((o) => !o)}
            aria-label={open ? "折叠" : "展开"}
            className="text-muted-foreground hover:text-foreground w-3 inline-block"
          >
            {open ? "▾" : "▸"}
          </button>
        ) : (
          <span className="w-3 inline-block" />
        )}
        <span
          className={cn("text-blue-600 dark:text-blue-400", pathHit && "bg-yellow-200 dark:bg-yellow-900")}
        >
          {name}
        </span>
        <span className="text-muted-foreground">:</span>
        {!isContainer && (
          <span
            className={cn(
              typeof value === "string" && "text-green-700 dark:text-green-400",
              typeof value === "number" && "text-orange-600 dark:text-orange-400",
              typeof value === "boolean" && "text-purple-600 dark:text-purple-400",
              value === null && "text-muted-foreground",
            )}
          >
            {summary(value)}
          </span>
        )}
        {isContainer && !open && (
          <span className="text-muted-foreground">{summary(value)}</span>
        )}
      </div>
      {isContainer && open && (
        <div>
          {entries.map(([k, v]) => (
            <JsonNode
              key={String(k)}
              name={k}
              value={v}
              depth={depth + 1}
              path={`${path}.${k}`}
              needle={needle}
              defaultOpen={depth < 1}
            />
          ))}
          {overflow > 0 && (
            <div className="text-muted-foreground pl-3">... ({overflow} more)</div>
          )}
        </div>
      )}
    </div>
  );
}

export function StateInspector() {
  const latestState = useDebugStore((s) => s.latestState);
  const currentSessionId = useChatStore((s) => s.currentSessionId);
  const { refreshState } = useDebug();
  const [needle, setNeedle] = useState("");

  // 面板打开时主动拉一次；之后由用户点刷新
  useEffect(() => {
    if (currentSessionId !== null) {
      void refreshState(currentSessionId);
    }
  }, [refreshState, currentSessionId]);

  return (
    <div className="flex flex-col h-full gap-2">
      <div className="flex items-center gap-2">
        <Input
          placeholder="按 key 路径搜索（如 messages.0.role）"
          value={needle}
          onChange={(e) => setNeedle(e.target.value)}
          className="h-8"
        />
        <Button
          variant="outline"
          size="sm"
          onClick={() => {
            if (currentSessionId !== null) {
              void refreshState(currentSessionId);
            }
          }}
          className="shrink-0"
        >
          <RefreshCw className="h-3 w-3 mr-1" />
          刷新
        </Button>
      </div>
      <div className="flex-1 overflow-auto rounded-md border bg-muted/30 p-2">
        {latestState === null ? (
          <div className="text-muted-foreground text-sm">
            尚未加载 state。点"刷新"从主进程拉取最新快照。
          </div>
        ) : (
          <JsonNode
            name="state"
            value={latestState}
            depth={0}
            path="state"
            needle={needle.trim().toLowerCase()}
            defaultOpen={true}
          />
        )}
      </div>
    </div>
  );
}
