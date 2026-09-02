'use client';

import { useState } from 'react';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { MessageSquare, Trash2, MoreHorizontal } from 'lucide-react';

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
        'group relative flex cursor-pointer items-center gap-2 rounded px-2 py-1.5 hover:bg-gray-200',
        isActive && 'bg-gray-200',
      )}
      onClick={onClick}
      onMouseEnter={() => setShowActions(true)}
      onMouseLeave={() => setShowActions(false)}
    >
      <MessageSquare className="h-4 w-4 shrink-0 text-gray-400" />
      {isEditing ? (
        <Input
          value={editingTitle}
          onChange={(e) => onEditTitleChange(e.target.value)}
          onBlur={onFinishEdit}
          onKeyDown={(e) => {
            if (e.key === 'Enter') onFinishEdit();
            if (e.key === 'Escape') onFinishEdit();
          }}
          className="h-6 text-sm"
          autoFocus
          onClick={(e) => e.stopPropagation()}
        />
      ) : (
        <span className="flex-1 truncate text-sm">{session.title}</span>
      )}

      {showActions && !isEditing && (
        <div className="absolute right-1 flex items-center gap-1">
          <Button
            variant="ghost"
            size="icon"
            className="h-6 w-6"
            onClick={(e) => {
              e.stopPropagation();
              onStartEdit();
            }}
          >
            <MoreHorizontal className="h-3 w-3" />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            className="h-6 w-6 text-red-500 hover:text-red-600"
            onClick={onDelete}
          >
            <Trash2 className="h-3 w-3" />
          </Button>
        </div>
      )}
    </div>
  );
}
