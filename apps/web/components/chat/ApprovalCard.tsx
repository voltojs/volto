'use client';

import { useState } from 'react';
import { ShieldAlert } from 'lucide-react';
import { Button } from '@/components/ui/button';
import type { PendingApproval } from '@/lib/approvals';

interface ApprovalCardProps {
  approval: PendingApproval;
  onDecide: (
    callId: string,
    decision: 'allow' | 'allow_always' | 'deny',
  ) => Promise<void>;
}

/**
 * Render the tool arguments for a human about to authorize them. A single
 * string argument (the common `bash` case) is shown raw so the command is
 * readable; anything else is pretty-printed JSON.
 */
function formatApprovalInput(input: Record<string, unknown>): string {
  const values = Object.values(input);
  // The common `bash` case is a single string argument; show it raw so the
  // command reads as a command rather than as escaped JSON.
  if (values.length === 1 && typeof values[0] === 'string') return values[0];
  return JSON.stringify(input, null, 2);
}

/**
 * Rendered inline at the end of the feed rather than as a modal: approving a
 * tool call needs the surrounding context of what the agent was doing, and a
 * modal covers exactly that.
 */
export function ApprovalCard({ approval, onDecide }: ApprovalCardProps) {
  const [busy, setBusy] = useState(false);

  const decide = async (decision: 'allow' | 'allow_always' | 'deny') => {
    if (busy) return;
    setBusy(true);
    try {
      await onDecide(approval.callId, decision);
    } finally {
      // The card disappears when the decision event lands; releasing here
      // covers the failure path, where it stays and must stay clickable.
      setBusy(false);
    }
  };

  return (
    <div className="border-border bg-muted/40 rounded-lg border p-3">
      <div className="flex items-center gap-2 text-sm">
        <ShieldAlert className="text-destructive/80 h-4 w-4 shrink-0" />
        <span>
          需要你的批准：
          <code className="font-mono">{approval.toolName}</code>
          <span className="text-muted-foreground ml-1 text-xs">
            ({approval.riskTier})
          </span>
        </span>
      </div>
      {approval.input !== undefined ? (
        <pre className="bg-background/60 text-muted-foreground mt-2 max-h-40 overflow-auto rounded border p-2 font-mono text-xs whitespace-pre-wrap">
          {formatApprovalInput(approval.input)}
        </pre>
      ) : (
        <p className="text-muted-foreground mt-2 text-xs">
          （该调用的参数已不在回放缓冲区内，无法显示）
        </p>
      )}
      <div className="mt-3 flex gap-2">
        <Button size="sm" disabled={busy} onClick={() => void decide('allow')}>
          允许一次
        </Button>
        <Button
          size="sm"
          variant="outline"
          disabled={busy}
          onClick={() => void decide('allow_always')}
        >
          本会话总是允许
        </Button>
        <Button
          size="sm"
          variant="ghost"
          disabled={busy}
          onClick={() => void decide('deny')}
        >
          拒绝
        </Button>
      </div>
    </div>
  );
}
