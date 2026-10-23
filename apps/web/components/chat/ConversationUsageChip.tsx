'use client';

import { Database } from 'lucide-react';
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover';
import type { TurnUsage } from '@volto/sdk/sse';
import { formatCompactTokens } from '@/lib/context-meter-model';
import {
  cacheHitRate,
  formatCacheHitRate,
  formatExactTokens,
} from '@/lib/turn-usage-model';
import { PopoverRow } from './PopoverRow';

/**
 * Whole-conversation token usage in the bottom status bar: a total+hit-rate
 * line that is always on, with the same breakdown rows as the per-round
 * chip in the hover panel. `usage` is the conversation-wide fold (see
 * conversationUsage) — no route row: one conversation can span models.
 */
export function ConversationUsageChip({ usage }: { usage: TurnUsage }) {
  const summary = `${formatCompactTokens(usage.totalTokens)} tok · 缓存命中 ${formatCacheHitRate(
    cacheHitRate(usage),
  )}`;

  return (
    <Popover>
      <PopoverTrigger
        aria-label="整个对话用量"
        className="text-muted-foreground hover:bg-muted hover:text-foreground flex items-center gap-1.5 rounded px-1.5 py-0.5 font-mono text-[10px]"
      >
        <Database className="h-3 w-3" aria-hidden />
        <span>{summary}</span>
      </PopoverTrigger>
      <PopoverContent side="top" align="start" className="max-w-[28rem]">
        {/* gap-3 + shrunk-both: the header keeps air between title and a
            long total, and neither side gets squeezed into the other. */}
        <div className="flex items-center justify-between gap-3 border-b pb-2">
          <span className="flex shrink-0 items-center gap-1.5 text-xs font-medium">
            <Database className="h-3.5 w-3.5" aria-hidden />
            整个对话用量
          </span>
          <span className="shrink-0 whitespace-nowrap font-mono text-xs font-medium">
            {formatExactTokens(usage.totalTokens)} tok
          </span>
        </div>
        <ul className="mt-2 space-y-1 text-xs">
          <PopoverRow
            label="缓存命中"
            value={formatCacheHitRate(cacheHitRate(usage))}
          />
          <PopoverRow
            label="未缓存输入"
            value={`${formatExactTokens(usage.inputTokens)} tok`}
          />
          <PopoverRow
            label="缓存读取"
            value={`${formatExactTokens(usage.cacheReadTokens)} tok`}
          />
          <PopoverRow
            label="缓存写入"
            value={`${formatExactTokens(usage.cacheWriteTokens)} tok`}
          />
          <PopoverRow
            label="输出"
            value={`${formatExactTokens(usage.outputTokens)} tok`}
          />
        </ul>
        {usage.missingUsageCalls > 0 && (
          <p className="text-muted-foreground mt-2 border-t pt-2 text-[10px]">
            全部对话另有 {usage.missingUsageCalls} 次模型调用未返回用量，未计入
          </p>
        )}
      </PopoverContent>
    </Popover>
  );
}
