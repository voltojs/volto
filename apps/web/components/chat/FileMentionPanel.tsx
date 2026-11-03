// apps/web/components/chat/FileMentionPanel.tsx
'use client';

import { forwardRef, useImperativeHandle, useEffect, useRef } from 'react';
import { useTranslations } from 'next-intl';
import { Folder, File as FileIcon } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Kbd } from '@/components/ui/kbd';
import { cn } from '@/lib/utils';
import { useFileMentionItems } from '@/hooks/use-file-mention-items';
import { useMenuNavigation } from '@/hooks/use-menu-navigation';
import { drillPath, type MentionEntry } from '@/lib/mention-data';

export interface FileMentionPanelProps {
  query: string;
  projectId: string | null;
  onSelect: (entry: MentionEntry) => void;
  onDrill: (entry: MentionEntry) => void;
}

export interface FileMentionPanelHandle {
  onKeyDown: (event: KeyboardEvent) => boolean;
}

/** @文件面板：查询驱动（见 lib/mention-data.ts）。
 *  点击目录 = 进目录（浏览）；Tab 在目录上 = 进目录；
 *  Enter 在目录/文件上 = 选中插入 mention（目录也可直接被引用）。 */
export const FileMentionPanel = forwardRef<FileMentionPanelHandle, FileMentionPanelProps>(
  function FileMentionPanel({ query, projectId, onSelect, onDrill }, ref) {
    const t = useTranslations('chat');
    const { entries, status, retry } = useFileMentionItems(projectId, query);
    const nav = useMenuNavigation({
      itemCount: entries.length,
      enabled: true,
      onSelect: (i) => {
        // Enter 语义：目录与文件一律选中插入。进目录用 Tab 或点击。
        const entry = entries[i];
        if (entry) onSelect(entry);
      },
      onTab: (i) => {
        const entry = entries[i];
        if (entry && drillPath(entry) !== undefined) onDrill(entry);
      },
    });
    const panelRef = useRef<HTMLDivElement>(null);

    // 键盘导航越过可视窗口时把 active 行滚进视野（面板 max-h-64，搜索可返回
    // 200 行；block:'nearest' 不打扰已在视野内的高亮）。查询此刻的 DOM 而非
    // 缓存行引用——行列表随 entries 整体重渲染，索引会过期。
    useEffect(() => {
      panelRef.current
        ?.querySelector('[data-path][aria-selected="true"]')
        ?.scrollIntoView({ block: 'nearest' });
    }, [nav.activeIndex]);

    useImperativeHandle(
      ref,
      () => ({
        onKeyDown: (event: KeyboardEvent) => {
          if (event.key === 'Enter') {
            nav.handleKeyDown(event); // 目录/文件 → onSelect（选中插入）
            return true; // 恒吞咽
          }
          if (event.key === 'Tab') {
            nav.handleKeyDown(event); // 目录 → onDrill；文件 → 无事发生
            return true;              // 但都吞掉，防焦点逃出编辑器
          }
          return nav.handleKeyDown(event);
        },
      }),
      // nav 每次渲染都是新对象（hook 返回新字面量），handle 因此逐渲染重建——
      // 无需再列 entries（exhaustive-deps 亦判其为多余依赖）。
      [nav],
    );

    return (
      <div
        ref={panelRef}
        data-testid="file-mention-panel"
        className="bg-popover z-50 max-h-64 w-80 overflow-y-auto rounded-lg border p-1 text-sm shadow-md"
      >
        {status === 'loading' ? (
          <div className="text-muted-foreground px-2 py-1.5">{t('common.loadingFiles')}</div>
        ) : status === 'error' ? (
          <div className="text-destructive flex items-center gap-2 px-2 py-1.5">
            <span className="truncate">{t('common.filesFailed')}</span>
            <Button variant="ghost" size="sm" className="h-6 shrink-0" onClick={retry}>
              {t('common.retry')}
            </Button>
          </div>
        ) : entries.length === 0 ? (
          <div className="text-muted-foreground px-2 py-1.5">{t('common.noFiles')}</div>
        ) : (
          <div role="listbox" aria-label={t('common.projectFiles')}>
            {entries.map((entry, i) => {
              const active = i === nav.activeIndex;
              const isDir = entry.type === 'dir';
              return (
                <button
                  key={entry.path}
                  type="button"
                  role="option"
                  aria-selected={active}
                  data-path={entry.path}
                  className={cn(
                    'flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left',
                    active && 'bg-accent',
                  )}
                  onClick={() => (isDir ? onDrill(entry) : onSelect(entry))}
                  onMouseEnter={() => nav.setActiveIndex(i)}
                >
                  {isDir ? (
                    <Folder className="text-muted-foreground h-4 w-4 shrink-0" />
                  ) : (
                    <FileIcon className="text-muted-foreground h-4 w-4 shrink-0" />
                  )}
                  <span className="min-w-0 flex-1 truncate">{entry.name}</span>
                  {/* Hint: dir → Tab (drill); both dir/file → Enter (select) is
                      the universal insert key, so only Tab is called out on dirs. */}
                  <Kbd
                    className={cn('shrink-0', active ? 'opacity-100' : 'opacity-45')}
                    aria-hidden
                  >
                    {isDir ? 'Tab' : '⏎'}
                  </Kbd>
                </button>
              );
            })}
          </div>
        )}
      </div>
    );
  },
);
