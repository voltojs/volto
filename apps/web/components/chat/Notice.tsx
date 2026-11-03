'use client';

import { CircleSlash } from 'lucide-react';
import { formatClockTime } from '@/lib/time-format';
import { useLocale } from 'next-intl';



interface NoticeProps {
  text: string;
  time: number;
}

/**
 * A neutral status row in the conversation — a turn the user stopped, a
 * model-tier fallback. Deliberately not styled like `ErrorNotice`: neither
 * is a failure, both are outcomes.
 */
export function Notice({ text, time }: NoticeProps) {
  const locale = useLocale();
  return (
    <div className="text-muted-foreground flex items-center gap-2 py-2.5 text-xs">
      <CircleSlash className="h-3 w-3 shrink-0" />
      <span>{text}</span>
      <span className="text-muted-foreground/70 font-mono text-[10px]">
        {formatClockTime(time, locale)}
      </span>
    </div>
  );
}
