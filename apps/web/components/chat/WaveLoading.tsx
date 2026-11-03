'use client';

import { useTranslations } from 'next-intl';

/**
 * The feed's one loading affordance: a row of dots waving at the bottom of
 * the message list for the whole round. Replaces every per-bubble caret —
 * one indicator that is visible the moment a send leaves, not only once the
 * first token lands.
 */
export function WaveLoading() {
  const t = useTranslations('chat');
  return (
    <div
      role="status"
      aria-label={t('common.generating')}
      data-testid="wave-loading"
      className="flex items-end justify-center gap-1.5 py-3"
    >
      {Array.from({ length: 5 }, (_, i) => (
        <span
          key={i}
          aria-hidden="true"
          className="wave-dot bg-primary h-1.5 w-1.5 rounded-full"
          style={{ animationDelay: `${i * 0.15}s` }}
        />
      ))}
    </div>
  );
}
