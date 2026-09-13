// apps/web/components/chat/FileMentionPanel.tsx
'use client';

import { forwardRef, useImperativeHandle } from 'react';
import { Folder, File as FileIcon } from 'lucide-react';
import { Button } from '@/components/ui/button';
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

/** @文件面板：查询驱动（见 lib/mention-data.ts）。目录点击 = 进目录，
 *  文件点击 = 选中插入。键盘 Tab 在目录上进目录、在文件上吞咽防焦点逃逸。 */
export const FileMentionPanel = forwardRef<FileMentionPanelHandle, FileMentionPanelProps>(
  function FileMentionPanel({ query, projectId, onSelect, onDrill }, ref) {
    const { entries, status, retry } = useFileMentionItems(projectId, query);
    const nav = useMenuNavigation({
      itemCount: entries.length,
      enabled: true,
      onSelect: (i) => {
        const entry = entries[i];
        if (!entry) return;
        // Enter 语义（spec §4）：目录条目 = 进目录（与 Tab、点击目录行一致），
        // 文件条目才选中插入。
        if (drillPath(entry) !== undefined) onDrill(entry);
        else onSelect(entry);
      },
      onTab: (i) => {
        const entry = entries[i];
        if (entry && drillPath(entry) !== undefined) onDrill(entry);
      },
    });

    useImperativeHandle(
      ref,
      () => ({
        onKeyDown: (event: KeyboardEvent) => {
          if (event.key === 'Enter') {
            nav.handleKeyDown(event);
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
        data-testid="file-mention-panel"
        className="bg-popover z-50 max-h-64 w-80 overflow-y-auto rounded-lg border p-1 text-sm shadow-md"
      >
        {status === 'loading' ? (
          <div className="text-muted-foreground px-2 py-1.5">加载文件…</div>
        ) : status === 'error' ? (
          <div className="text-destructive flex items-center gap-2 px-2 py-1.5">
            <span className="truncate">文件列表加载失败</span>
            <Button variant="ghost" size="sm" className="h-6 shrink-0" onClick={retry}>
              重试
            </Button>
          </div>
        ) : entries.length === 0 ? (
          <div className="text-muted-foreground px-2 py-1.5">无匹配文件</div>
        ) : (
          <div role="listbox" aria-label="项目文件">
            {entries.map((entry, i) => {
              const active = i === nav.activeIndex;
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
                  onClick={() => (entry.type === 'dir' ? onDrill(entry) : onSelect(entry))}
                  onMouseEnter={() => nav.setActiveIndex(i)}
                >
                  {entry.type === 'dir' ? (
                    <Folder className="text-muted-foreground h-4 w-4 shrink-0" />
                  ) : (
                    <FileIcon className="text-muted-foreground h-4 w-4 shrink-0" />
                  )}
                  <span className="truncate">{entry.name}</span>
                </button>
              );
            })}
          </div>
        )}
      </div>
    );
  },
);
