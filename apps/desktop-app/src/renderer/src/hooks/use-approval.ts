/**
 * use-approval.ts
 * 订阅主进程推过来的 `agent:approval-request` 事件，把挂起的审批请求维护在
 * 一个 FIFO 队列里；ApprovalDialog 只渲染当前队首；用户点 allow/deny 时通过
 * `agent.decideApproval` 写回。
 *
 * 设计要点：
 * - 不直接放到 chat-store 里——审批是与会话正交的横切关心
 * - 启动时一次性 `listApprovals()` 补齐已存在的挂起请求（窗口重开场景）
 * - `decide()` 调用 IPC，返回结果按 handled 字段判断是否真正生效
 *   （超时/重复决策时主进程已经把它清掉，此时直接从队列里移除即可）
 */

import { useCallback, useEffect, useState } from "react";
import type { ApprovalRequest } from "@/renderer/src/types/electron";

export type { ApprovalRequest };

interface UseApprovalApi {
  /** 当前挂起的审批队列；UI 只渲染 queue[0] */
  queue: ApprovalRequest[];
  /** 队首的待审批请求；nullable */
  current: ApprovalRequest | null;
  /** 对指定请求做出决策 */
  decide: (requestId: string, decision: "allow" | "deny") => Promise<void>;
}

export function useApproval(): UseApprovalApi {
  const [queue, setQueue] = useState<ApprovalRequest[]>([]);

  // 启动时补齐已挂起的请求 + 订阅后续推送
  useEffect(() => {
    if (typeof window === "undefined" || !window.electronAPI?.agent) return;
    const api = window.electronAPI.agent;
    let cancelled = false;

    void api
      .listApprovals()
      .then((existing) => {
        if (cancelled) return;
        if (Array.isArray(existing) && existing.length > 0) {
          // 合并去重：list 拉回的可能与已到的 push 事件重复
          setQueue((prev) => {
            const seen = new Set(prev.map((r) => r.requestId));
            const merged = [...prev];
            for (const r of existing) {
              if (!seen.has(r.requestId)) merged.push(r);
            }
            return merged;
          });
        }
      })
      .catch((err) => {
        console.error("[use-approval] listApprovals failed:", err);
      });

    const unsubscribe = api.onApprovalRequest((payload: ApprovalRequest) => {
      setQueue((prev) => {
        if (prev.some((r) => r.requestId === payload.requestId)) return prev;
        return [...prev, payload];
      });
    });

    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, []);

  const decide = useCallback(
    async (requestId: string, decision: "allow" | "deny") => {
      const api = window.electronAPI?.agent;
      if (!api) return;
      try {
        await api.decideApproval(requestId, decision);
      } catch (err) {
        console.error("[use-approval] decide failed:", err);
      } finally {
        // 不论 IPC 返回 handled 是否为 true，都从渲染端队列摘掉该项
        setQueue((prev) => prev.filter((r) => r.requestId !== requestId));
      }
    },
    [],
  );

  return {
    queue,
    current: queue[0] ?? null,
    decide,
  };
}
