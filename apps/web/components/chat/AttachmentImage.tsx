'use client';

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import type { ConversationBlock } from '@volto/sdk/sse';
import { gatewayUrl } from '@/lib/gateway-base';

export type ImageBlock = Extract<ConversationBlock, { type: 'image' }>;

/**
 * One history image: ref-only in state, resolved against the attachment route.
 *
 * Browser auth is the gateway's HttpOnly cookie on the same-origin gateway
 * route — a plain same-origin `<img>` carries it automatically, so no
 * crossOrigin / credentials plumbing exists (and `<img>` offers none).
 * A cleaned-up attachment degrades to an explanation rather than a broken
 * image icon: the icon cannot say why the picture is missing.
 */
export function AttachmentImage({
  block,
  sessionId,
}: {
  block: ImageBlock;
  sessionId?: string | null;
}) {
  const t = useTranslations('chat');
  const [failed, setFailed] = useState(false);

  if (!sessionId || failed) {
    return (
      <div className="text-muted-foreground rounded-md border border-dashed px-2 py-1 text-xs">
        {failed ? t('common.imageUnavailable') : t('common.imageBlock')}（{block.mediaType ?? 'image'} ·{' '}
        {block.attachmentId}）
      </div>
    );
  }

  const src = gatewayUrl(
    `/attachments/${encodeURIComponent(block.attachmentId)}?sessionId=${encodeURIComponent(sessionId)}`,
  );
  return (
    <img
      src={src}
      alt="attachment"
      className="max-h-64 max-w-full rounded-md object-contain"
      onError={() => setFailed(true)}
    />
  );
}
