'use client';

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { Download, ZoomIn, ZoomOut } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog';

const MIN_ZOOM = 0.5;
const MAX_ZOOM = 4;
const ZOOM_STEP = 0.25;

function clampZoom(value: number): number {
  return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, Math.round(value * 100) / 100));
}

/**
 * Full-size image viewer: wheel or the buttons zoom, and the toolbar offers a
 * download. Kept independent of where the image came from so screenshots,
 * rendered files, and future attachment sources share one surface.
 */
export function ImageLightbox({
  open,
  onOpenChange,
  src,
  alt,
  downloadName = 'image.png',
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  src: string;
  alt: string;
  downloadName?: string;
}) {
  const t = useTranslations('chat');
  const [zoom, setZoom] = useState(1);


  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="w-auto max-w-[min(94vw,1200px)] gap-0 overflow-hidden p-0 sm:max-w-[min(94vw,1200px)]">
        <DialogTitle className="sr-only">{alt}</DialogTitle>

        <div
          data-testid="image-lightbox-viewport"
          onWheel={(event) => {
            event.preventDefault();
            setZoom((current) =>
              clampZoom(current + (event.deltaY < 0 ? ZOOM_STEP : -ZOOM_STEP)),
            );
          }}
          className="max-h-[78vh] w-[min(90vw,1100px)] overflow-auto bg-black/20 p-2"
        >
          <img
            src={src}
            alt={alt}
            style={{ width: `${zoom * 100}%` }}
            className="mx-auto block h-auto max-w-none"
          />
        </div>

        <div className="flex items-center justify-center gap-1 border-t p-2">
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            aria-label={t('tool.zoomOut')}
            disabled={zoom <= MIN_ZOOM}
            onClick={() => setZoom((current) => clampZoom(current - ZOOM_STEP))}
          >
            <ZoomOut />
          </Button>
          <span className="text-muted-foreground w-12 text-center font-mono text-xs tabular-nums">
            {Math.round(zoom * 100)}%
          </span>
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            aria-label={t('tool.zoomIn')}
            disabled={zoom >= MAX_ZOOM}
            onClick={() => setZoom((current) => clampZoom(current + ZOOM_STEP))}
          >
            <ZoomIn />
          </Button>
          <a
            href={src}
            download={downloadName}
            className="text-muted-foreground hover:bg-muted hover:text-foreground ml-2 inline-flex h-7 items-center gap-1 rounded-lg px-2 text-xs transition-colors"
          >
            <Download className="size-3.5" />
            {t('tool.download')}
          </a>
        </div>
      </DialogContent>
    </Dialog>
  );
}
