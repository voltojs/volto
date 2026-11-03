'use client';

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { Check, Copy } from 'lucide-react';
import type { ConversationMessage } from '@volto/sdk/sse';
import { TurnUsageChip } from './TurnUsageChip';
import { formatTimestamp } from '@/lib/time-format';

/**
 * Time, copy and round usage under the last row a message produced.
 *
 * A message can now span several rows (text, execution group, text), so the
 * footer rides whichever row holds its tail — including a collapsed group:
 * a tool-only ending used to disappear whole, and the usage chip is the only
 * trace that such a round happened.
 */
export function MessageFooter({ message }: { message: ConversationMessage }) {
  const t = useTranslations('chat');
  const [copied, setCopied] = useState(false);

  const copy = async () => {
    await navigator.clipboard.writeText(message.content);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  if (message.isStreaming) return null;
  if (message.content === '' && message.turnUsage === undefined) return null;

  return (
    <div className="mt-1 flex items-center gap-2">
      <span className="text-muted-foreground/70 font-mono text-[10px]">
        {formatTimestamp(message.timestamp)}
      </span>
      {message.content !== '' && (
        <button
          type="button"
          onClick={() => void copy()}
          aria-label={t('common.copyAria')}
          className="text-muted-foreground hover:bg-muted hover:text-foreground flex items-center rounded px-1 py-0.5"
        >
          {copied ? <Check className="text-success h-3 w-3" /> : <Copy className="h-3 w-3" />}
        </button>
      )}
      {message.turnUsage !== undefined && <TurnUsageChip usage={message.turnUsage} />}
    </div>
  );
}
