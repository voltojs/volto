// apps/web/components/chat/SlashPanel.tsx
'use client';

import { forwardRef, useImperativeHandle, useMemo, Fragment, useEffect, useRef } from 'react';
import { useTranslations } from 'next-intl';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { useSlashCommandItems } from '@/hooks/use-slash-command-items';
import { useMenuNavigation } from '@/hooks/use-menu-navigation';
import { filterCommandItems, groupCommandItems, type CommandItem } from '@/lib/input-commands';

export interface SlashPanelProps {
  query: string;
  projectId: string | null;
  onSelect: (item: CommandItem) => void;
}

export interface SlashPanelHandle {
  onKeyDown: (event: KeyboardEvent) => boolean;
}

/**
 * 分组斜杠命令面板。数据自取（hook 内有模块缓存），键盘事件经 imperative
 * handle 由 suggestion 的 render.onKeyDown 委托进来。
 */
export const SlashPanel = forwardRef<SlashPanelHandle, SlashPanelProps>(
  function SlashPanel({ query, projectId, onSelect }, ref) {
    const t = useTranslations('chat');
    const { items, isLoading, error, retry } = useSlashCommandItems(projectId);
    const filtered = useMemo(() => filterCommandItems(items, query), [items, query]);
    const grouped = useMemo(() => groupCommandItems(filtered), [filtered]);
    const nav = useMenuNavigation({
      itemCount: filtered.length,
      enabled: true,
      onSelect: (i) => {
        const item = filtered[i];
        if (item) onSelect(item);
      },
    });
    const panelRef = useRef<HTMLDivElement>(null);

    // 键盘导航越过可视窗口时把 active 行滚进视野（面板 max-h-64，搜索可返回
    // 200 行；block:'nearest' 不打扰已在视野内的高亮）。查询此刻的 DOM 而非
    // 缓存行引用——行列表随 filtered 整体重渲染，索引会过期。
    useEffect(() => {
      panelRef.current
        ?.querySelector('[data-item-name][aria-selected="true"]')
        ?.scrollIntoView({ block: 'nearest' });
    }, [nav.activeIndex]);

    useImperativeHandle(
      ref,
      () => ({
        onKeyDown: (event: KeyboardEvent) => {
          // Enter 恒消费（空列表吞咽，防止单段落编辑器被插入段落）；其余键交给
          // nav —— Arrow 循环消费，Escape/Tab 返回 false 交插件原生 dismiss/放行。
          if (event.key === 'Enter') {
            nav.handleKeyDown(event);
            return true;
          }
          return nav.handleKeyDown(event);
        },
      }),
      // nav 每次渲染都是新对象（hook 返回新字面量），handle 因此逐渲染重建——
      // 无需再列 filtered（exhaustive-deps 亦判其为多余依赖）。
      [nav],
    );

    return (
      <div
        ref={panelRef}
        data-testid="slash-panel"
        className="bg-popover z-50 max-h-64 w-96 max-w-[min(24rem,calc(100vw-1.5rem))] overflow-y-auto rounded-lg border p-1 text-sm shadow-md"
      >
        {isLoading ? (
          <div className="text-muted-foreground px-2 py-1.5">{t('common.loadingCommands')}</div>
        ) : error ? (
          <div className="text-destructive flex items-center gap-2 px-2 py-1.5">
            <span className="truncate">{error}</span>
            <Button variant="ghost" size="sm" className="h-6 shrink-0" onClick={retry}>
              {t('common.retry')}
            </Button>
          </div>
        ) : filtered.length === 0 ? (
          <div className="text-muted-foreground px-2 py-1.5">{t('common.noCommands')}</div>
        ) : (
          <div role="listbox" aria-label={t('common.slashCommands')}>
            {(['builtin', 'skills'] as const).map((groupKey) => {
              const group = grouped[groupKey];
              if (group.length === 0) return null;
              const offset = groupKey === 'builtin' ? 0 : grouped.builtin.length;
              return (
                <Fragment key={groupKey}>
                  <div className="text-muted-foreground px-2 pt-1.5 pb-1 text-xs">
                    {groupKey === 'builtin' ? t('common.builtin') : 'SKILLS'}
                  </div>
                  {group.map((item, i) => {
                    const index = offset + i;
                    const active = index === nav.activeIndex;
                    return (
                      <button
                        key={`${item.kind}:${item.name}`}
                        type="button"
                        role="option"
                        aria-selected={active}
                        data-item-name={item.name}
                        className={cn(
                          'flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left',
                          active && 'bg-accent',
                        )}
                        onClick={() => onSelect(item)}
                        onMouseEnter={() => nav.setActiveIndex(index)}
                      >
                        {/* Single-line row: name never wraps; description yields via truncate */}
                        <span className="max-w-[70%] shrink-0 truncate whitespace-nowrap font-medium">
                          /{item.name}
                        </span>
                        <span className="text-muted-foreground min-w-0 flex-1 truncate text-xs">
                          {item.description}
                        </span>
                      </button>
                    );
                  })}
                </Fragment>
              );
            })}
          </div>
        )}
      </div>
    );
  },
);
