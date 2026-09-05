'use client';

import { CircleAlert } from 'lucide-react';

const timeFormatter = new Intl.DateTimeFormat('zh-CN', {
  hour: '2-digit',
  minute: '2-digit',
});

interface ErrorNoticeProps {
  text: string;
  time: number;
}

/**
 * One failure notice in the conversation: a local send failure, an unbound
 * session, or a turn the agent ended on an error before producing content.
 * Rendered as its own row so the failure is never silently swallowed.
 */
export function ErrorNotice({ text, time }: ErrorNoticeProps) {
  // Some producers already prefix the message with an emoji; the row's icon
  // makes that redundant.
  const clean = text.replace(/^⚠️\s*/, '');
  return (
    <div className="group py-2.5">
      <div className="mb-1.5 flex items-baseline gap-2">
        <span className="text-destructive flex items-center gap-1 font-mono text-[10px] font-semibold tracking-[0.14em] uppercase">
          <CircleAlert className="h-3 w-3" /> error
        </span>
        <span className="text-muted-foreground/70 font-mono text-[10px]">
          {timeFormatter.format(time)}
        </span>
      </div>
      <div className="text-destructive/90 bg-destructive/5 border-destructive/30 rounded-md border px-3 py-2 text-xs whitespace-pre-wrap">
        {clean}
      </div>
    </div>
  );
}
