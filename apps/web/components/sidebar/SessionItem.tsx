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
        'group relative flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-sidebar-foreground/85 transition-colors hover:bg-sidebar-accent hover:text-sidebar-foreground',
        isActive && 'bg-sidebar-accent font-medium text-sidebar-foreground',
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
        <span className="flex-1 truncate text-[13px]">{session.title}</span>
      )}

      {showActions && !isEditing && (
        <div className="absolute right-1 flex items-center gap-0.5 bg-sidebar-accent pl-1">
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
            className="text-muted-foreground hover:text-destructive"
            onClick={onDelete}
            aria-label="删除会话"
          >
            <Trash2 className="h-3 w-3" />
          </Button>
        </div>
      )}
    </div>
  );
}
