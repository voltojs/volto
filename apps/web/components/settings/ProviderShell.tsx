'use client';

import type { ReactNode } from 'react';
import { useTranslations } from 'next-intl';
import { ChevronDown, Pencil, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';

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
  return (
    <div className="bg-card/50 overflow-hidden rounded-lg border">
      <div className="flex items-center gap-2 px-3 py-2">
        {/* The whole row toggles: a one-line row is a small target, and the
            pencil below is kept only as the affordance that says so. */}
        <button
          type="button"
          onClick={onToggle}
          aria-expanded={expanded}
          className="flex min-w-0 flex-1 items-center gap-2 text-left"
        >
          <ChevronDown
            className={`text-muted-foreground h-3.5 w-3.5 shrink-0 transition-transform ${
              expanded ? '' : '-rotate-90'
            }`}
          />
          <span className="truncate font-medium">{name}</span>
          {badges}
        </button>
        <Button
          variant="ghost"
          size="icon-sm"
          onClick={onToggle}
          aria-label={expanded ? t('providers.shellCollapse') : t('providers.shellEdit')}
          className="shrink-0"
        >
          <Pencil className="h-3.5 w-3.5" />
        </Button>
        <Button
          variant="ghost"
          size="icon-sm"
          className="text-destructive hover:text-destructive hover:bg-destructive/10 shrink-0"
          onClick={onRemove}
          aria-label={t('providers.delete')}
        >
          <Trash2 className="h-3.5 w-3.5" />
        </Button>
      </div>
      {expanded && (
        <div className="space-y-3 border-t px-3 py-3">{children}</div>
      )}
    </div>
  );
}
