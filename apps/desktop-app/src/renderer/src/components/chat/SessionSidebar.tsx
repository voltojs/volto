/**
 * SessionSidebar
 * 会话管理：切换、删除、重命名
 */

import { useState } from "react";
import { MoreHorizontal, Pencil, Trash2, X, Check } from "lucide-react";
import { Button } from "@/renderer/src/components/ui/button";
import { Input } from "@/renderer/src/components/ui/input";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/renderer/src/components/ui/dropdown-menu";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/renderer/src/components/ui/alert-dialog";
import { cn } from "@/renderer/src/lib/utils";
import { useChatStore, type Session } from "@/renderer/src/stores/chat-store";

/** SessionSidebar 属性 */
export interface SessionSidebarProps {
  /** 会话数据 */
  session: Session;
  /** 是否为当前会话 */
  isActive: boolean;
  /** 点击事件 */
  onClick: () => void;
  /** 自定义类名 */
  className?: string;
}

/**
 * SessionSidebar 组件
 * 单个会话项，支持重命名和删除
 */
export function SessionSidebar({
  session,
  isActive,
  onClick,
  className,
}: SessionSidebarProps) {
  const [isEditing, setIsEditing] = useState(false);
  const [editTitle, setEditTitle] = useState(session.title);
  const [showDeleteDialog, setShowDeleteDialog] = useState(false);
  const { renameSession, deleteSession } = useChatStore();

  /** 开始编辑 */
  const handleStartEdit = (e: React.MouseEvent) => {
    e.stopPropagation();
    setEditTitle(session.title);
    setIsEditing(true);
  };

  /** 保存编辑 */
  const handleSaveEdit = (e?: React.MouseEvent) => {
    e?.stopPropagation();
    if (editTitle.trim()) {
      renameSession(session.id, editTitle.trim());
    }
    setIsEditing(false);
  };

  /** 取消编辑 */
  const handleCancelEdit = (e?: React.MouseEvent) => {
    e?.stopPropagation();
    setEditTitle(session.title);
    setIsEditing(false);
  };

  /** 处理键盘事件 */
  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter") {
      handleSaveEdit();
    } else if (e.key === "Escape") {
      handleCancelEdit();
    }
  };

  /** 确认删除 */
  const handleConfirmDelete = () => {
    deleteSession(session.id);
    setShowDeleteDialog(false);
  };

  /** 获取最后一条消息预览 */
  const lastMessage = session.messages[session.messages.length - 1];
  const preview = lastMessage?.content.slice(0, 30) ?? "暂无消息";

  return (
    <>
      <div
        className={cn(
          "group relative flex items-center gap-2 p-3 rounded-lg cursor-pointer transition-colors",
          "hover:bg-accent hover:text-accent-foreground",
          isActive && "bg-accent text-accent-foreground",
          className,
        )}
        onClick={onClick}
      >
        {/* 编辑模式 */}
        {isEditing ? (
          <div className="flex items-center gap-1 flex-1" onClick={(e) => e.stopPropagation()}>
            <Input
              value={editTitle}
              onChange={(e) => setEditTitle(e.target.value)}
              onKeyDown={handleKeyDown}
              className="h-7 text-sm"
              autoFocus
            />
            <Button variant="ghost" size="icon" className="h-7 w-7" onClick={handleSaveEdit}>
              <Check className="h-4 w-4" />
            </Button>
            <Button variant="ghost" size="icon" className="h-7 w-7" onClick={handleCancelEdit}>
              <X className="h-4 w-4" />
            </Button>
          </div>
        ) : (
          <>
            {/* 会话信息 */}
            <div className="flex-1 min-w-0">
              <div className="font-medium text-sm truncate">{session.title}</div>
              <div className="text-xs text-muted-foreground truncate mt-0.5">
                {preview}
              </div>
            </div>

            {/* 操作菜单 */}
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-7 w-7 opacity-0 group-hover:opacity-100 transition-opacity"
                  onClick={(e) => e.stopPropagation()}
                >
                  <MoreHorizontal className="h-4 w-4" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuItem onClick={handleStartEdit}>
                  <Pencil className="h-4 w-4 mr-2" />
                  重命名
                </DropdownMenuItem>
                <DropdownMenuItem
                  onClick={(e) => {
                    e.stopPropagation();
                    setShowDeleteDialog(true);
                  }}
                  className="text-destructive"
                >
                  <Trash2 className="h-4 w-4 mr-2" />
                  删除
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </>
        )}
      </div>

      {/* 删除确认对话框 */}
      <AlertDialog open={showDeleteDialog} onOpenChange={setShowDeleteDialog}>
        <AlertDialogContent onClick={(e: React.MouseEvent) => e.stopPropagation()}>
          <AlertDialogHeader>
            <AlertDialogTitle>确认删除</AlertDialogTitle>
            <AlertDialogDescription>
              确定要删除会话 &quot;{session.title}&quot; 吗？此操作无法撤销。
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>取消</AlertDialogCancel>
            <AlertDialogAction onClick={handleConfirmDelete} className="bg-destructive text-destructive-foreground">
              删除
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
