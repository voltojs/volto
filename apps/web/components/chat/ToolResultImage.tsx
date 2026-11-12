'use client';

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { gatewayUrl } from '@/lib/gateway-base';
import { cn } from '@/lib/utils';
import { ImageLightbox } from './ImageLightbox';
import type { ConversationImage } from '@volto/sdk/sse';

function imageSrc(image: ConversationImage, sessionId: string): string {
  return gatewayUrl(
    `/attachments/${encodeURIComponent(image.attachmentId)}?sessionId=${encodeURIComponent(sessionId)}`,
  );
}

/**
 * A tool-result image (browser screenshot, rendered file): thumbnail in the
 * trace, full-size in a dialog. The attachment is ref-only, so the session
 * that owns it is required to build the same-origin URL.
 */
export function ToolResultImage({
  image,
  sessionId,
  className,
}: {
  image: ConversationImage;
  sessionId?: string | null;
  className?: string;
}) {
  const t = useTranslations('chat');
  const [open, setOpen] = useState(false);
  const [failed, setFailed] = useState(false);

  if (!sessionId || failed) {
    return (
      <div className="text-muted-foreground rounded-md border border-dashed px-2 py-1 text-xs">
        {failed ? t('common.imageUnavailable') : t('common.imageBlock')}（{image.mediaType} · {image.attachmentId}）
      </div>
    );
  }

  const src = imageSrc(image, sessionId);
  return (
    <>
      <button
        type="button"
        aria-label={t('tool.expandScreenshot')}
        onClick={() => setOpen(true)}
        className={cn(
          'group relative block max-w-full cursor-zoom-in overflow-hidden rounded-md border border-border/60 bg-muted/30',
          className,
        )}
      >
        <img
          src={src}
          alt={t('tool.screenshot')}
          onError={() => setFailed(true)}
          className="max-h-44 w-auto max-w-full object-contain transition-opacity group-hover:opacity-90"
        />
      </button>
      {open && (
        <ImageLightbox
          open
          onOpenChange={setOpen}
          src={src}
          alt={t('tool.screenshot')}
          downloadName={`${image.attachmentId}.png`}
        />
      )}
    </>
  );
}
