'use client';

import { useCallback, useRef, useState } from 'react';
import type { PointerEvent as ReactPointerEvent } from 'react';
import { useTranslations } from 'next-intl';
import { Download, X, ZoomIn, ZoomOut } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogTitle,
} from '@/components/ui/dialog';

const MIN_ZOOM = 0.5;
const MAX_ZOOM = 4;
const ZOOM_STEP = 0.25;

function clampZoom(value: number): number {
  return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, Math.round(value * 100) / 100));
}

interface DragState {
  pointerId: number;
  startX: number;
  startY: number;
  originX: number;
  originY: number;
}

/**
 * Full-screen image viewer. The image sits on a dark translucent mask, scales
 * with the wheel/buttons, and can be panned by dragging with the left mouse
 * button. The viewport is overflow-hidden: no scrollbars, no page scroll.
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
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [dragging, setDragging] = useState(false);
  const drag = useRef<DragState | null>(null);
  const viewportRef = useRef<HTMLDivElement | null>(null);
  const wheelHandler = useRef((event: WheelEvent) => {
    event.preventDefault();
    setZoom((current) =>
      clampZoom(current + (event.deltaY < 0 ? ZOOM_STEP : -ZOOM_STEP)),
    );
  });
  const attachViewport = useCallback((node: HTMLDivElement | null) => {
    if (viewportRef.current !== null) {
      viewportRef.current.removeEventListener('wheel', wheelHandler.current);
    }
    viewportRef.current = node;
    if (node !== null) {
      node.addEventListener('wheel', wheelHandler.current, { passive: false });
    }
  }, []);

  const applyZoom = (next: number): void => {
    const value = clampZoom(next);
    setZoom(value);
    if (value <= 1) setPan({ x: 0, y: 0 });
  };

  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>): void => {
    if (event.button !== 0) return;
    event.preventDefault();
    if (typeof event.currentTarget.setPointerCapture === 'function') {
      event.currentTarget.setPointerCapture(event.pointerId);
    }
    drag.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      originX: pan.x,
      originY: pan.y,
    };
    setDragging(true);
  };

  const onPointerMove = (event: ReactPointerEvent<HTMLDivElement>): void => {
    const state = drag.current;
    if (state === null || state.pointerId !== event.pointerId) return;
    setPan({
      x: state.originX + event.clientX - state.startX,
      y: state.originY + event.clientY - state.startY,
    });
  };

  const endDrag = (event: ReactPointerEvent<HTMLDivElement>): void => {
    if (drag.current?.pointerId !== event.pointerId) return;
    drag.current = null;
    setDragging(false);
    if (typeof event.currentTarget.releasePointerCapture === 'function') {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        overlayClassName="bg-black/80 backdrop-blur-sm"
        showCloseButton={false}
        className="fixed inset-0 top-0 left-0 flex h-dvh w-screen max-w-none translate-x-0 translate-y-0 flex-col rounded-none bg-transparent p-0 ring-0 sm:max-w-none"
      >
        <DialogTitle className="sr-only">{alt}</DialogTitle>

        <div
          ref={attachViewport}
          data-testid="image-lightbox-viewport"
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={endDrag}
          onPointerCancel={endDrag}
          className="flex min-h-0 w-full flex-1 touch-none items-center justify-center overflow-hidden select-none"
          style={{ cursor: dragging ? 'grabbing' : 'grab' }}
        >
          <img
            src={src}
            alt={alt}
            draggable={false}
            className="max-h-full max-w-full object-contain select-none"
            style={{
              transform: `translate3d(${pan.x}px, ${pan.y}px, 0) scale(${zoom})`,
              transformOrigin: 'center center',
              willChange: 'transform',
            }}
          />
        </div>

        <div className="pointer-events-none absolute inset-x-0 bottom-6 flex justify-center">
          <div className="pointer-events-auto flex items-center gap-1 rounded-full bg-black/65 px-2 py-1.5 text-white shadow-lg backdrop-blur">
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              className="text-white hover:bg-white/15 disabled:opacity-40"
              aria-label={t('tool.zoomOut')}
              disabled={zoom <= MIN_ZOOM}
              onClick={() => applyZoom(zoom - ZOOM_STEP)}
            >
              <ZoomOut />
            </Button>
            <span className="w-12 text-center font-mono text-xs tabular-nums">
              {Math.round(zoom * 100)}%
            </span>
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              className="text-white hover:bg-white/15 disabled:opacity-40"
              aria-label={t('tool.zoomIn')}
              disabled={zoom >= MAX_ZOOM}
              onClick={() => applyZoom(zoom + ZOOM_STEP)}
            >
              <ZoomIn />
            </Button>
            <a
              href={src}
              download={downloadName}
              className="ml-1 inline-flex h-7 items-center gap-1 rounded-full px-2 text-xs text-white/90 transition-colors hover:bg-white/15 hover:text-white"
            >
              <Download className="size-3.5" />
              {t('tool.download')}
            </a>
          </div>
        </div>

        <DialogClose
          render={
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              className="absolute top-4 right-4 text-white hover:bg-white/15"
            />
          }
        >
          <X />
          <span className="sr-only">{t('common.close')}</span>
        </DialogClose>
      </DialogContent>
    </Dialog>
  );
}
