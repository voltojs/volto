'use client';

import { useState } from 'react';
import { ShieldAlert } from 'lucide-react';
import { classifyCommandRisk } from '@volto/sdk/sse';
import { Button } from '@/components/ui/button';
import { riskNoteFor } from '@/lib/approvals';
import type { PendingApproval } from '@/lib/approvals';

interface ApprovalCardProps {
  approval: PendingApproval;
  onDecide: (
    callId: string,
    decision: 'allow' | 'deny',
  ) => Promise<void>;
}

/**
 * The sole string argument of a tool call, when that is what the input is —
 * the common `bash` case. Returns undefined for anything else, which is what
 * keeps the rendered command and the risk notes describing the same thing:
 * both callers below read the command through this one function.
 *
 * Deliberately does not look up `input.command` by name: that would couple
 * this generic approval card to one tool's schema. A multi-field input (e.g.
 * `bash` with a `cwd` alongside `command`) falls back to JSON display and no
 * risk notes below — an accepted false negative, not a schema-specific reach.
 */
export function soleStringArg(input: Record<string, unknown>): string | undefined {
  const values = Object.values(input);
  return values.length === 1 && typeof values[0] === 'string' ? values[0] : undefined;
}

/**
 * Render the tool arguments for a human about to authorize them. A single
 * string argument (the common `bash` case) is shown raw so the command is
 * readable; anything else is pretty-printed JSON.
 */
function formatApprovalInput(input: Record<string, unknown>): string {
  return soleStringArg(input) ?? JSON.stringify(input, null, 2);
}

/**
 * Risk notes for the command being approved, derived from the SAME input the
 * card renders — never carried on the approval event, which deliberately
 * omits arguments so a second copy cannot drift from the one that executes.
 *
 * Routes through `soleStringArg`, the same extraction `formatApprovalInput`
 * uses, so the classified string and the displayed string can never diverge:
 * a multi-field input yields no notes rather than risk classifying whichever
 * field `Object.values` happens to put first.
 */
export function riskNotesFor(input: Record<string, unknown> | undefined): string[] {
  if (!input) return [];
  const command = soleStringArg(input);
  return command === undefined ? [] : classifyCommandRisk(command).map(riskNoteFor);
}

/**
 * Rendered inline at the end of the feed rather than as a modal: approving a
 * tool call needs the surrounding context of what the agent was doing, and a
 * modal covers exactly that.
 */
export function ApprovalCard({ approval, onDecide }: ApprovalCardProps) {
  const [busy, setBusy] = useState(false);
  const riskNotes = riskNotesFor(approval.input);

  const decide = async (decision: 'allow' | 'deny') => {
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
      {riskNotes.length > 0 ? (
        <ul className="text-destructive/90 mt-2 space-y-0.5 text-xs">
          {riskNotes.map((note) => (
            <li key={note}>· {note}</li>
          ))}
        </ul>
      ) : null}
      <div className="mt-3 flex gap-2">
        <Button size="sm" disabled={busy} onClick={() => void decide('allow')}>
          允许一次
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
