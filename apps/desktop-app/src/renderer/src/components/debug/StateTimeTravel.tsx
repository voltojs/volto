/**
 * StateTimeTravel
 * 时间旅行调试（M12）— 列出当前会话的 checkpoint 历史，回退查看某个
 * checkpoint 的状态，并给出它与当前 agent 状态的 diff。
 *
 * 设计：
 * - 只读回退：rewind 只加载 checkpoint 状态 + 算 diff，不改变 agent 运行状态。
 *   真正的"回退后继续跑"需要把状态经 resetTurnForNextInput 作为新 agent 的
 *   initialState（主进程/内核侧能力），本面板聚焦查看与对比。
 * - checkpoint 由 runner 在每个 turn 边界 + HITL 审批暂停时写入
 *   `<sessionId>#<seq>`。
 */

import { useCallback, useEffect, useState } from "react";
import { History, RefreshCw } from "lucide-react";
import { Button } from "@/renderer/src/components/ui/button";
import { Badge } from "@/renderer/src/components/ui/badge";
import { useChatStore } from "@/renderer/src/stores/chat-store";
import { cn } from "@/renderer/src/lib/utils";

interface CheckpointSummary {
  seq: number;
  status: string;
  messageCount: number;
  createdAt: number;
}

interface RewindDiff {
  hasChanges: boolean;
  statusChanged?: { from: string; to: string };
  tokensDelta?: number;
  iterationsDelta?: number;
  messagesAdded?: number;
  messagesRemoved?: number;
  readFilesAdded?: string[];
  readFilesRemoved?: string[];
}

const STATUS_COLOR: Record<string, string> = {
  done: "bg-green-500/15 text-green-600",
  calling_model: "bg-blue-500/15 text-blue-600",
  executing_tools: "bg-amber-500/15 text-amber-600",
  waiting_for_approval: "bg-purple-500/15 text-purple-600",
  waiting_for_input: "bg-slate-500/15 text-slate-600",
};

function formatTime(ts: number): string {
  if (!ts) return "-";
  return new Date(ts).toLocaleTimeString("zh-CN", { hour12: false });
}

function DiffRow({ label, value }: { label: string; value: string | number | undefined | null }) {
  if (value === undefined || value === null) return null;
  return (
    <div className="flex items-baseline justify-between gap-2 text-xs">
      <span className="text-muted-foreground shrink-0">{label}</span>
      <span className="font-mono text-right break-all">{String(value)}</span>
    </div>
  );
}

export function StateTimeTravel() {
  const currentSessionId = useChatStore((s) => s.currentSessionId);
  const [checkpoints, setCheckpoints] = useState<CheckpointSummary[] | null>(null);
  const [selectedSeq, setSelectedSeq] = useState<number | null>(null);
  const [diff, setDiff] = useState<RewindDiff | null>(null);
  const [stateSummary, setStateSummary] = useState<Record<string, unknown> | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const refresh = useCallback(async () => {
    if (!currentSessionId) return;
    setError(null);
    const res = await window.electronAPI.agent.listCheckpoints(currentSessionId);
    if (res.success) {
      setCheckpoints(res.checkpoints ?? []);
    } else {
      setError(res.error ?? "无法获取 checkpoint 列表");
      setCheckpoints(null);
    }
  }, [currentSessionId]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const rewind = async (seq: number) => {
    if (!currentSessionId) return;
    setLoading(true);
    setError(null);
    try {
      const res = await window.electronAPI.agent.rewindCheckpoint(currentSessionId, seq);
      if (res.success && res.result) {
        setSelectedSeq(seq);
        setDiff(res.result.diff);
        setStateSummary(res.result.state);
      } else {
        setError(res.error ?? "回退失败");
      }
    } finally {
      setLoading(false);
    }
  };

  const diffEntries: Array<[string, string | number]> = [];
  if (diff) {
    if (diff.statusChanged) diffEntries.push([`status ${diff.statusChanged.from} → ${diff.statusChanged.to}`, ""]);
    if (diff.tokensDelta) diffEntries.push(["tokens 增量", diff.tokensDelta]);
    if (diff.iterationsDelta) diffEntries.push(["iteration 增量", diff.iterationsDelta]);
    if (diff.messagesAdded) diffEntries.push(["新增消息", diff.messagesAdded]);
    if (diff.messagesRemoved) diffEntries.push(["移除消息", diff.messagesRemoved]);
    if (diff.readFilesAdded?.length) diffEntries.push(["新增 readFiles", diff.readFilesAdded.join(", ")]);
    if (diff.readFilesRemoved?.length) diffEntries.push(["移除 readFiles", diff.readFilesRemoved.join(", ")]);
  }

  return (
    <div className="flex flex-col gap-3 h-full min-h-0">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <History className="h-3.5 w-3.5" />
          <span>会话 checkpoint（每轮 turn 边界 + 审批暂停写入）</span>
        </div>
        <Button variant="ghost" size="icon" className="h-7 w-7" onClick={refresh} aria-label="刷新 checkpoint 列表" title="刷新">
          <RefreshCw className="h-3.5 w-3.5" />
        </Button>
      </div>

      {!currentSessionId && (
        <p className="text-xs text-muted-foreground">当前没有活跃会话。</p>
      )}

      {checkpoints !== null && checkpoints.length === 0 && currentSessionId && (
        <p className="text-xs text-muted-foreground">
          尚无 checkpoint——先运行一轮对话（或触发一次审批暂停），turn 结束时内核会写入历史。
        </p>
      )}

      {error && <p className="text-xs text-red-500">{error}</p>}

      <div className="flex flex-col gap-1.5 overflow-auto min-h-0">
        {checkpoints?.map((cp) => (
          <button
            key={cp.seq}
            type="button"
            onClick={() => rewind(cp.seq)}
            disabled={loading}
            className={cn(
              "flex items-center justify-between gap-2 rounded-md border px-2.5 py-1.5 text-left text-xs transition-colors",
              selectedSeq === cp.seq
                ? "border-primary/60 bg-primary/10"
                : "border-border bg-card hover:bg-muted/60",
            )}
          >
            <span className="flex items-center gap-2">
              <span className="font-mono text-muted-foreground">#{cp.seq}</span>
              <Badge variant="outline" className={cn("font-normal", STATUS_COLOR[cp.status] ?? "")}>
                {cp.status}
              </Badge>
            </span>
            <span className="text-muted-foreground">
              {cp.messageCount} 条消息 · {formatTime(cp.createdAt)}
            </span>
          </button>
        ))}
      </div>

      {selectedSeq !== null && diff && (
        <div className="flex flex-col gap-1.5 rounded-md border p-2.5">
          <div className="text-xs font-medium">
            #{selectedSeq} vs 当前状态
            <Badge variant="outline" className={cn("ml-2 font-normal", diff.hasChanges ? "bg-amber-500/15 text-amber-600" : "bg-green-500/15 text-green-600")}>
              {diff.hasChanges ? "有差异" : "一致"}
            </Badge>
          </div>
          {diffEntries.length === 0 && !diff.hasChanges && (
            <p className="text-xs text-muted-foreground">两个状态完全相同。</p>
          )}
          {diffEntries.length === 0 && diff.hasChanges && (
            <p className="text-xs text-muted-foreground">存在差异（详见下方字段）。</p>
          )}
          {diffEntries.map(([label, value]) => (
            <DiffRow key={label} label={label} value={value} />
          ))}
        </div>
      )}

      {stateSummary && (
        <details className="rounded-md border p-2.5">
          <summary className="cursor-pointer text-xs font-medium">checkpoint 状态快照</summary>
          <pre className="mt-2 max-h-40 overflow-auto rounded bg-muted/40 p-2 text-[10px] leading-relaxed">
            {JSON.stringify({ status: stateSummary.status, messages: stateSummary.messages }, null, 2)}
          </pre>
        </details>
      )}
    </div>
  );
}
