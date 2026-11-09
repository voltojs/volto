'use client';

import { ArrowUpDown, ChevronRight } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { cn } from '@/lib/utils';

export interface SectionSortOption {
  value: string;
  label: string;
}

interface SectionHeaderProps {
  title: string;
  /** Rendered next to the title when defined (the pinned section's count). */
  count?: number;
  collapsed: boolean;
  onToggleCollapsed: () => void;
  sort: {
    value: string;
    options: readonly SectionSortOption[];
    onChange: (value: string) => void;
  };
  /** Trailing control of the owning section (e.g. "add workspace"). */
  action?: React.ReactNode;
}

/**
 * The title row shared by the sidebar's two sections: collapse toggle, sort
 * menu and an optional trailing action. Kept as one component so the two
 * sections cannot drift apart in spacing or affordances.
 */
export function SectionHeader({
  title,
  count,
  collapsed,
  onToggleCollapsed,
  sort,
  action,
}: SectionHeaderProps) {
  const t = useTranslations('sidebar');
  return (
    <div className="flex items-center justify-between gap-1 px-3 pt-3 pb-1.5">
      <div className="flex min-w-0 items-center gap-1">
        <button
          type="button"
          onClick={onToggleCollapsed}
          aria-expanded={!collapsed}
          aria-label={
            collapsed
              ? t('section.expand', { title })
              : t('section.collapse', { title })
          }
          className="text-muted-foreground hover:text-foreground flex min-w-0 items-center gap-1.5 rounded-md px-1 py-0.5"
        >
          <ChevronRight
            className={cn(
              'h-3 w-3 shrink-0 transition-transform duration-150',
              { 'rotate-90': !collapsed },
            )}
          />
          <span className="truncate font-mono text-[10px] font-medium tracking-[0.14em] uppercase">
            {title}
          </span>
        </button>
        {count !== undefined && (
          <span className="text-muted-foreground/70 font-mono text-[10px]">
            {t('pinned.count', { count })}
          </span>
        )}
      </div>
      <div className="flex shrink-0 items-center gap-0.5">
        <DropdownMenu>
          <DropdownMenuTrigger
            render={
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label={t('sort.label')}
              />
            }
          >
            <ArrowUpDown className="h-3.5 w-3.5" />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuRadioGroup
              value={sort.value}
              onValueChange={(value: string) => sort.onChange(value)}
            >
              {sort.options.map((option) => (
                <DropdownMenuRadioItem key={option.value} value={option.value}>
                  {option.label}
                </DropdownMenuRadioItem>
              ))}
            </DropdownMenuRadioGroup>
          </DropdownMenuContent>
        </DropdownMenu>
        {action}
      </div>
    </div>
  );
}