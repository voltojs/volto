'use client';

import { useState, type ReactNode } from 'react';
import { useTranslations } from 'next-intl';
import { ChevronDown, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogMedia,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';

/**
 * Collapsed-by-default shell shared by both provider kinds.
 *
 * A configured provider is normally something you glance at, not something
 * you edit — so it reads as one row (name on the left, actions on the right)
 * and only unfolds into its form when asked. Both sections use this so the
 * two lists stay visually the same list, differing only in what their
 * expanded body contains.
 */
export function ProviderShell({
  name,
  badges,
  expanded,
  onToggle,
  onRemove,
  children,
}: {
  name: string;
  /** Compact identity hints (pi-ai provider id, masked key, model count). */
  badges?: ReactNode;
  expanded: boolean;
  onToggle: () => void;
  onRemove: () => void;
  children: ReactNode;
}) {
  const t = useTranslations('settings');
  const [confirmDeleteOpen, setConfirmDeleteOpen] = useState(false);
  return (
    <div className="bg-card/50 overflow-hidden rounded-lg border">
      <div className="flex items-center gap-2 px-3 py-2">
        {/* The whole row toggles; the pencil was redundant because clicking
            the row is the edit affordance. Delete stays a separate action
            and opens a confirmation dialog. */}
        <Button
          type="button"
          variant="ghost"
          onClick={onToggle}
          aria-expanded={expanded}
          aria-label={expanded ? t('providers.shellCollapse') : t('providers.shellEdit')}
          className="h-auto min-w-0 flex-1 justify-start gap-2 rounded-none px-0 text-left font-normal hover:bg-transparent"
        >
          <ChevronDown
            className={`text-muted-foreground h-3.5 w-3.5 shrink-0 transition-transform ${
              expanded ? '' : '-rotate-90'
            }`}
          />
          <span className="truncate font-medium">{name}</span>
          {badges}
        </Button>
        <Button
          variant="ghost"
          size="icon-sm"
          className="text-destructive hover:text-destructive hover:bg-destructive/10 shrink-0"
          onClick={() => setConfirmDeleteOpen(true)}
          aria-label={t('providers.delete')}
        >
          <Trash2 className="h-3.5 w-3.5" />
        </Button>
      </div>
      {expanded && (
        <div className="space-y-3 border-t px-3 py-3">{children}</div>
      )}

      <AlertDialog open={confirmDeleteOpen} onOpenChange={setConfirmDeleteOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogMedia>
              <Trash2 className="text-destructive" />
            </AlertDialogMedia>
            <AlertDialogTitle>
              {t('providers.deleteTitle', { name })}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {t('providers.deleteBody')}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t('providers.cancel')}</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              onClick={() => {
                setConfirmDeleteOpen(false);
                onRemove();
              }}
            >
              {t('providers.deleteConfirm')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
