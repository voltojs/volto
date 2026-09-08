'use client';

import { CircleSlash } from 'lucide-react';

const timeFormatter = new Intl.DateTimeFormat('zh-CN', {
  hour: '2-digit',
  minute: '2-digit',
});

interface NoticeProps {
  text: string;
  time: number;
}

/**
 * A neutral status row in the conversation — currently only "the user stopped
 * this turn". Deliberately not styled like `ErrorNotice`: an interruption the
 * user asked for is an outcome, not a failure.
 */
export function Notice({ text, time }: NoticeProps) {
  return (
    <div className="text-muted-foreground flex items-center gap-2 py-2.5 text-xs">
      <CircleSlash className="h-3 w-3 shrink-0" />
      <span>{text}</span>
      <span className="text-muted-foreground/70 font-mono text-[10px]">
        {timeFormatter.format(time)}
      </span>
    </div>
  );
}
