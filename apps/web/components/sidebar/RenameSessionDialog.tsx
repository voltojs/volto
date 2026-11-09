'use client';

import { useEffect, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';

interface RenameSessionDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Current title; re-seeded every time the dialog opens. */
  initialTitle: string;
  /** Receives the trimmed title. Never called with an empty string. */
  onSubmit: (title: string) => void;
}

/**
 * Rename a session in a dialog rather than inline.
 *
 * Inline editing lived inside the row's hover container, so the pointer
 * leaving the row unmounted the input mid-edit (and the "more" menu's own
 * trigger had to stay mounted for the popup to keep its anchor). A dialog is
 * portalled outside the row, so neither problem exists.
 */
export function RenameSessionDialog({
  open,
  onOpenChange,
  initialTitle,
  onSubmit,
}: RenameSessionDialogProps) {
  const t = useTranslations('sidebar');
  // The owner mounts this component per open, so the initial state is the
  // title as it is at that moment — no reset-in-effect, which would cascade
  // renders.
  const [title, setTitle] = useState(initialTitle);
  const inputRef = useRef<HTMLInputElement>(null);

  // The menu that opened this dialog restores focus to its own trigger as it
  // closes, which can land after the dialog's autofocus and leave the caret on
  // the trigger. Take the focus back once the open commit has settled.
  useEffect(() => {
    if (!open) return;
    const frame = requestAnimationFrame(() => {
      inputRef.current?.focus();
      inputRef.current?.select();
    });
    return () => cancelAnimationFrame(frame);
  }, [open]);

  const trimmed = title.trim();
  const submit = () => {
    if (trimmed.length === 0) return;
    onOpenChange(false);
    onSubmit(trimmed);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      {/* React portals still bubble events through the React tree: without
          this, typing or clicking here would also reach the sidebar row that
          renders the dialog. */}
      <DialogContent onClick={(e) => e.stopPropagation()}>
        <DialogHeader>
          <DialogTitle>{t('session.renameTitle')}</DialogTitle>
        </DialogHeader>
        <Input
          ref={inputRef}
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          onFocus={(e) => e.currentTarget.select()}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              submit();
            }
            if (e.key === 'Escape') {
              e.preventDefault();
              onOpenChange(false);
            }
          }}
        />
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            {t('cancel')}
          </Button>
          <Button onClick={submit} disabled={trimmed.length === 0}>
            {t('session.renameSave')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}