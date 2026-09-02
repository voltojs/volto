'use client';

import { useState } from 'react';
import { ChevronDown, ChevronRight, Wrench, CircleAlert, Check, Loader } from 'lucide-react';
import type { ToolCall } from '@/stores/chat-store';
import { cn } from '@/lib/utils';

interface ToolCallCardProps {
  call: ToolCall;
}

function StatusIcon({ call }: ToolCallCardProps) {
  if (call.result === undefined) {
    return <Loader className="h-3.5 w-3.5 animate-spin text-gray-400" />;
  }
  return call.isError ? (
    <CircleAlert className="h-3.5 w-3.5 text-red-500" />
  ) : (
    <Check className="h-3.5 w-3.5 text-green-600" />
  );
}

/** Collapsed summary of one tool call, expandable to show arguments/result. */
export function ToolCallCard({ call }: ToolCallCardProps) {
  const [expanded, setExpanded] = useState(false);
  const meta = call.result as { durationMs?: number } | undefined;

  return (
    <div
      className={cn(
        'rounded-md border text-xs',
        call.isError ? 'border-red-200 bg-red-50' : 'border-gray-200 bg-white',
      )}
    >
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        className="flex w-full items-center gap-2 px-2 py-1.5 text-left"
        aria-expanded={expanded}
      >
        {expanded ? (
          <ChevronDown className="h-3.5 w-3.5 text-gray-400" />
        ) : (
          <ChevronRight className="h-3.5 w-3.5 text-gray-400" />
        )}
        <Wrench className="h-3.5 w-3.5 text-gray-500" />
        <span className="font-mono text-gray-800">{call.name}</span>
        <span className="ml-auto">
          <StatusIcon call={call} />
        </span>
      </button>

      {expanded && (
        <div className="space-y-2 border-t px-2 py-2">
          <div>
            <div className="mb-1 text-gray-500">参数</div>
            <pre className="overflow-x-auto rounded bg-gray-50 p-2 font-mono text-gray-700">
              {JSON.stringify(call.args, null, 2)}
            </pre>
          </div>
          {call.result !== undefined && (
            <div className="text-gray-600">
              {/* The protocol carries tool metadata, not the tool's output —
                  the output itself goes to the model, not the transcript. */}
              {call.isError ? '执行失败' : '执行成功'}
              {typeof meta?.durationMs === 'number' && ` · 耗时 ${meta.durationMs}ms`}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
