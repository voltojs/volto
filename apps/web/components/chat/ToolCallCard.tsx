'use client';

import {
  ChevronRight,
  Terminal,
  CircleAlert,
  Check,
  LoaderCircle,
} from 'lucide-react';
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '@/components/ui/collapsible';
import type { ToolCall } from '@/stores/chat-store';
import { cn } from '@/lib/utils';

interface ToolCallCardProps {
  call: ToolCall;
}

function StatusIcon({ call }: ToolCallCardProps) {
  if (call.result === undefined) {
    return (
      <LoaderCircle className="text-muted-foreground h-3.5 w-3.5 animate-spin" />
    );
  }
  return call.isError ? (
    <CircleAlert className="text-destructive h-3.5 w-3.5" />
  ) : (
    <Check className="text-success h-3.5 w-3.5" />
  );
}

/** Collapsed summary of one tool call, expandable to show arguments/result. */
export function ToolCallCard({ call }: ToolCallCardProps) {
  const meta = call.result as { durationMs?: number } | undefined;

  return (
    <Collapsible
      className={cn(
        'bg-card/60 overflow-hidden rounded-md border text-xs',
        call.isError && 'border-destructive/30 bg-destructive/5',
      )}
    >
      <CollapsibleTrigger className="group flex w-full items-center gap-2 px-2.5 py-1.5 text-left">
        <ChevronRight className="text-muted-foreground h-3.5 w-3.5 shrink-0 transition-transform duration-150 group-data-[panel-open]:rotate-90" />
        <Terminal className="text-muted-foreground h-3.5 w-3.5 shrink-0" />
        <span className="text-foreground/90 truncate font-mono">
          {call.name}
        </span>
        <span className="ml-auto shrink-0">
          <StatusIcon call={call} />
        </span>
      </CollapsibleTrigger>

      <CollapsibleContent className="h-(--collapsible-panel-height) overflow-hidden transition-[height] duration-200 ease-out data-[ending-style]:h-0 data-[starting-style]:h-0">
        <div className="space-y-2 border-t px-2.5 py-2">
          <div>
            <div className="text-muted-foreground mb-1 font-mono text-[10px] tracking-wide uppercase">
              参数
            </div>
            <pre className="bg-muted/60 text-foreground/80 overflow-x-auto rounded p-2 font-mono">
              {JSON.stringify(call.args, null, 2)}
            </pre>
          </div>
          {call.result !== undefined && (
            <div
              className={cn(
                'font-mono text-[11px]',
                call.isError ? 'text-destructive' : 'text-success',
              )}
            >
              {/* The protocol carries tool metadata, not the tool's output —
                  the output itself goes to the model, not the transcript. */}
              {call.isError ? '✕ 执行失败' : '✓ 执行成功'}
              {typeof meta?.durationMs === 'number' && (
                <span className="text-muted-foreground">
                  {' '}
                  · {meta.durationMs}ms
                </span>
              )}
            </div>
          )}
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}
