'use client';

import { Database } from 'lucide-react';
import type { TurnUsage } from '@volto/sdk/sse';
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover';
import { useConfigStore } from '@/stores/config-store';
import { PopoverRow } from './PopoverRow';
import { formatCompactTokens } from '@/lib/context-meter-model';
import {
  cacheHitRate,
  formatCacheHitRate,
  formatExactTokens,
  formatRoute,
} from '@/lib/turn-usage-model';

/**
 * 一轮对话的用量：页脚常驻紧凑 chip，点开是完整七行明细（spec 2026-09-26 §4）。
 * 常驻而非 hover 才现——用量是信息不是动作，藏起来等于没有；复制按钮可以
 * hover（用户知道它在那儿），这个不行。
 */
export function TurnUsageChip({ usage }: { usage: TurnUsage }) {
  // Config supplies display names for the route row; the store is read here
  // (not passed in) because every footer renders its own chip.
  const providers = useConfigStore((s) => s.providers);
  const catalogProviders = useConfigStore((s) => s.catalogProviders);
  const route = formatRoute(usage.source, providers, catalogProviders);

  return (
    <Popover>
      <PopoverTrigger
        aria-label="本轮用量"
        className="text-muted-foreground hover:bg-muted hover:text-foreground rounded px-1 py-0.5 font-mono text-[10px]"
      >
        用量 {formatCompactTokens(usage.totalTokens)} tok
      </PopoverTrigger>
      <PopoverContent
        side="top"
        align="start"
        className="max-w-[28rem]"
      >
        <div className="flex items-center justify-between border-b pb-1.5">
          <span className="flex items-center gap-1.5 text-xs font-medium">
            <Database className="h-3.5 w-3.5" aria-hidden />
            本轮用量
          </span>
          <span className="font-mono text-xs font-medium">
            {formatExactTokens(usage.totalTokens)} tok
          </span>
        </div>
        <ul className="mt-2 space-y-1 text-xs">
          <PopoverRow label="提供方 / 模型" value={route} />
          <PopoverRow label="缓存命中" value={formatCacheHitRate(cacheHitRate(usage))} />
          <PopoverRow label="未缓存输入" value={`${formatExactTokens(usage.inputTokens)} tok`} />
          <PopoverRow label="缓存读取" value={`${formatExactTokens(usage.cacheReadTokens)} tok`} />
          <PopoverRow label="缓存写入" value={`${formatExactTokens(usage.cacheWriteTokens)} tok`} />
          <PopoverRow label="输出" value={`${formatExactTokens(usage.outputTokens)} tok`} />
        </ul>
        {usage.missingUsageCalls > 0 && (
          <p className="text-muted-foreground mt-2 border-t pt-2 text-[10px]">
            本轮另有 {usage.missingUsageCalls} 次模型调用未返回用量，未计入
          </p>
        )}
      </PopoverContent>
    </Popover>
  );
}
