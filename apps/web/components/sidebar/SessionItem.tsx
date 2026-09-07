'use client';

import { useState } from 'react';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { MessageSquareText, Trash2, Pencil } from 'lucide-react';

interface SessionItemProps {
  session: { id: string; title: string; updatedAt: number };
  isActive: boolean;
  isEditing: boolean;
  editingTitle: string;
  /**
   * True while this session's channel is actively streaming a turn. Deleting
   * such a session races the server's transcript writes: a delete landing
   * between an in-flight `appendFile` and its completion can resurrect a
   * truncated transcript (the store's `deleteSession` isn't serialised with
   * `appendEventBatch` — see `packages/stores/jsonl/src/index.ts`). The full
   * fix needs a store-side tombstone; this only closes the one-click path an
   * ordinary user can trigger by disabling delete while generating.
   */
  isGenerating: boolean;
  onEditTitleChange: (title: string) => void;
  onStartEdit: () => void;
  onFinishEdit: () => void;
  onClick: () => void;
  onDelete: (e: React.MouseEvent) => void;
}

export function SessionItem({
  session,
  isActive,
  isEditing,
  editingTitle,
  isGenerating,
  onEditTitleChange,
  onStartEdit,
  onFinishEdit,
  onClick,
  onDelete,
}: SessionItemProps) {
  const [showActions, setShowActions] = useState(false);

  return (
    <div
      className={cn(
        'group text-sidebar-foreground/85 hover:bg-sidebar-accent hover:text-sidebar-foreground relative flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 transition-colors',
        isActive && 'bg-sidebar-accent text-sidebar-foreground font-medium',
      )}
      onClick={onClick}
      onMouseEnter={() => setShowActions(true)}
      onMouseLeave={() => setShowActions(false)}
    >
      <MessageSquareText
        className={cn(
          'h-3.5 w-3.5 shrink-0',
          isActive ? 'text-primary' : 'text-muted-foreground',
        )}
      />
      {isEditing ? (
        <Input
          value={editingTitle}
          onChange={(e) => onEditTitleChange(e.target.value)}
          onBlur={onFinishEdit}
          onKeyDown={(e) => {
            if (e.key === 'Enter') onFinishEdit();
            if (e.key === 'Escape') onFinishEdit();
          }}
          className="h-6 text-xs"
          autoFocus
          onClick={(e) => e.stopPropagation()}
        />
      ) : (
        <span className="flex-1 truncate text-[13px]">
          {session.title || '未命名会话'}
        </span>
      )}

      {showActions && !isEditing && (
        <div className="bg-sidebar-accent absolute right-1 flex items-center gap-0.5 pl-1">
          <Button
            variant="ghost"
            size="icon-xs"
            onClick={(e) => {
              e.stopPropagation();
              onStartEdit();
            }}
            aria-label="重命名"
          >
            <Pencil className="h-3 w-3" />
          </Button>
          <Button
            variant="ghost"
            size="icon-xs"
            className="text-muted-foreground hover:text-destructive disabled:pointer-events-auto disabled:opacity-40"
            onClick={onDelete}
            disabled={isGenerating}
            aria-label={isGenerating ? '会话正在生成中，无法删除' : '删除会话'}
            title={isGenerating ? '会话正在生成中，无法删除' : undefined}
          >
            <Trash2 className="h-3 w-3" />
          </Button>
        </div>
      )}
    </div>
  );
}
