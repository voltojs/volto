'use client';

import { useEffect, useState } from 'react';
import { Markdown } from '@/components/chat/Markdown';
import { Button } from '@/components/ui/button';
import { fetchPlan } from '@/lib/sessions-api';
import { selectLastTurnEnd } from '@/lib/todos-model';
import { useChatStore } from '@/stores/chat-store';
import { useSessionStore } from '@/stores/session-store';
import type { PaneTab } from '@/stores/pane-store';

/**
 * PlanPane 的入参（spec 2026-09-19 §3.5）：内容与可执行态由标签体（PlanTab）
 * 解析好再传进来，组件本身只负责呈现——markdown 渲染（与消息流同一信任
 * 模型：模型生成内容）+「按计划执行」按钮。
 */
export interface PlanPaneProps {
  sessionId: string;
  content: string;
  canExecute: boolean;
  onExecute: () => void;
}

export function PlanPane({
  sessionId,
  content,
  canExecute,
  onExecute,
}: PlanPaneProps) {
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div
        className="min-h-0 flex-1 overflow-y-auto px-4 py-3"
        data-testid="plan-doc"
        data-session-id={sessionId}
      >
        <Markdown content={content} />
      </div>
      <div className="border-t p-3">
        <Button className="w-full" disabled={!canExecute} onClick={onExecute}>
          按计划执行
        </Button>
      </div>
    </div>
  );
}

/** fetchPlan 的标签体态：loading（首拉 / 换会话）→ ready / empty（404 或失败）。 */
type PlanState =
  | { status: 'loading' }
  | { status: 'ready'; content: string }
  | { status: 'empty' };
/**
 * 注册进 RightPane 渲染表的 plan 标签壳：把 tab 载荷窄化成 PlanPane 的
 * props。内容按 sessionId 自拉（挂载 / 会话切换 / 主缓冲新 turn_end 三个
 * 时机——最后一个即「turn 结束自动刷新」，重拉期间保留旧内容不闪空态）；
 * 可执行态 = 计划模式 && 文档存在 && 非生成中 && 标签会话仍是当前会话
 * （后者防止跨会话遗留的标签把执行消息发进错误的会话）；执行动作原样上抛
 * 给 ChatPanel 的 onExecutePlan 派发回调（切回 planPreviousMode ?? 'ask'
 * + 发送执行消息），本组件不碰发送通道。
 */
export function PlanTab({
  tab,
  onExecutePlan,
}: {
  tab: PaneTab;
  onExecutePlan?: (sessionId: string) => void;
}) {
  // hooks 无条件调用（rules-of-hooks）：kind 窄化走三元派生，非本类标签
  // 在渲染处返回 null。tab.kind 对同一挂载实例恒定（换 kind 即换组件类型
  // → remount），钩子顺序稳定。
  const sessionId = tab.kind === 'plan' ? tab.sessionId : undefined;
  const lastTurnEnd = useChatStore((s) => selectLastTurnEnd(s.events));
  const generating = useChatStore((s) => s.isGenerating);
  const isPlanMode = useSessionStore((s) =>
    sessionId !== undefined
      ? s.sessions.find((session) => session.id === sessionId)
          ?.permissionMode === 'plan'
      : false,
  );
  const isCurrentSession = useSessionStore((s) =>
    sessionId !== undefined ? s.currentSessionId === sessionId : false,
  );

  // 拉取结果连同其来源 sessionId 一起存：展示时 sessionId 对不上当前标签
  // （换会话 / 切到另一个 plan 标签的首拉间隙）一律按 loading 读——重置因此
  // 是派生的，无需「setState 直接写在 effect 里」。重拉（同一会话的 turn
  // 结束）sessionId 不变，旧内容保留到新内容到达，不闪空态。
  const [fetched, setFetched] = useState<
    { sessionId: string; state: PlanState } | null
  >(null);
  const planState: PlanState =
    fetched !== null && fetched.sessionId === sessionId
      ? fetched.state
      : { status: 'loading' };

  // 自拉：挂载 / sessionId 变化 / turn 结束（lastTurnEnd 身份变化）。
  // 网络失败按「无计划」处理——计划是可重写的临时文档，不值得报错打断。
  useEffect(() => {
    if (sessionId === undefined) return;
    let cancelled = false;
    fetchPlan(sessionId)
      .then((plan) => {
        if (cancelled) return;
        setFetched({
          sessionId,
          state:
            plan === null
              ? { status: 'empty' }
              : { status: 'ready', content: plan.content },
        });
      })
      .catch(() => {
        if (!cancelled) setFetched({ sessionId, state: { status: 'empty' } });
      });
    return () => {
      cancelled = true;
    };
  }, [sessionId, lastTurnEnd]);

  if (tab.kind !== 'plan') return null;

  if (planState.status !== 'ready') {
    return (
      <div className="text-muted-foreground p-4 text-sm">
        {planState.status === 'loading' ? '加载计划…' : '尚无计划文档'}
      </div>
    );
  }

  return (
    <PlanPane
      sessionId={tab.sessionId}
      content={planState.content}
      canExecute={isPlanMode && !generating && isCurrentSession}
      onExecute={() => onExecutePlan?.(tab.sessionId)}
    />
  );
}
