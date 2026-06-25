/**
 * Sidebar
 * 会话列表 + 新建会话按钮
 */

import { useState } from "react";
import { Plus, MessageSquare, Settings, Bug } from "lucide-react";
import { Button } from "@/renderer/src/components/ui/button";
import { ScrollArea } from "@/renderer/src/components/ui/scroll-area";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/renderer/src/components/ui/dialog";
import { PermissionEditor } from "@/renderer/src/components/approval/PermissionEditor";
import { DebugPanel } from "@/renderer/src/components/debug/DebugPanel";
import { cn } from "@/renderer/src/lib/utils";
import { useChatStore, type Session } from "@/renderer/src/stores/chat-store";

/** Sidebar 属性 */
export interface SidebarProps {
  /** 自定义类名 */
  className?: string;
}

/**
 * Sidebar 组件
 * 显示会话列表和新建会话按钮
 */
export function Sidebar({ className }: SidebarProps) {
  const { sessions, currentSessionId, createSession, switchSession } = useChatStore();
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [debugOpen, setDebugOpen] = useState(false);

  /** 转换 Map 为数组 */
  const sessionList = Array.from(sessions.values()).sort(
    (a, b) => b.updatedAt - a.updatedAt,
  );

  /** 创建新会话 */
  const handleCreateSession = () => {
    createSession();
  };

  /** 切换会话 */
  const handleSwitchSession = (sessionId: string) => {
    switchSession(sessionId);
  };

  return (
    <div className={cn("flex flex-col h-full", className)}>
      {/* 头部 */}
      <div className="p-4 border-b flex items-start justify-between gap-2">
        <div>
          <h2 className="text-lg font-semibold">Volto Desktop</h2>
          <p className="text-xs text-muted-foreground mt-1">AI Agent 桌面应用</p>
        </div>
        <div className="flex items-center gap-1">
          <Button
            variant="ghost"
            size="icon"
            aria-label="打开调试面板"
            onClick={() => setDebugOpen(true)}
          >
            <Bug className="h-4 w-4" />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            aria-label="打开设置"
            onClick={() => setSettingsOpen(true)}
          >
            <Settings className="h-4 w-4" />
          </Button>
        </div>
      </div>

      {/* 新建会话按钮 */}
      <div className="p-2">
        <Button
          variant="outline"
          className="w-full justify-start gap-2"
          onClick={handleCreateSession}
        >
          <Plus className="h-4 w-4" />
          新建会话
        </Button>
      </div>

      {/* 会话列表 */}
      <ScrollArea className="flex-1">
        <div className="p-2 space-y-1">
          {sessionList.map((session) => (
            <SessionItem
              key={session.id}
              session={session}
              isActive={session.id === currentSessionId}
              onClick={() => handleSwitchSession(session.id)}
            />
          ))}

          {sessionList.length === 0 && (
            <div className="text-center py-8 text-muted-foreground text-sm">
              暂无会话
              <br />
              点击上方按钮创建新会话
            </div>
          )}
        </div>
      </ScrollArea>

      {/* 设置弹窗：当前仅含权限模式编辑器；后续可在此扩展 ApiKey / Model 等 */}
      <Dialog open={settingsOpen} onOpenChange={setSettingsOpen}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>设置</DialogTitle>
            <DialogDescription>
              修改后将在下次 Agent 创建时生效。
            </DialogDescription>
          </DialogHeader>
          <div className="pt-2">
            <PermissionEditor />
          </div>
        </DialogContent>
      </Dialog>

      {/* 调试面板：Sheet 抽屉，与 Sidebar 共享开关 state */}
      <DebugPanel open={debugOpen} onOpenChange={setDebugOpen} />
    </div>
  );
}

/** SessionItem 属性 */
interface SessionItemProps {
  /** 会话数据 */
  session: Session;
  /** 是否为当前会话 */
  isActive: boolean;
  /** 点击事件 */
  onClick: () => void;
}

/**
 * SessionItem 组件
 * 单个会话项
 */
function SessionItem({ session, isActive, onClick }: SessionItemProps) {
  /** 获取最后一条消息预览 */
  const lastMessage = session.messages[session.messages.length - 1];
  const preview = lastMessage?.content.slice(0, 50) ?? "暂无消息";

  /** 格式化时间 */
  const formatTime = (timestamp: number) => {
    const date = new Date(timestamp);
    const now = new Date();
    const isToday = date.toDateString() === now.toDateString();

    if (isToday) {
      return date.toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" });
    }
    return date.toLocaleDateString("zh-CN", { month: "short", day: "numeric" });
  };

  return (
    <button
      className={cn(
        "w-full text-left p-3 rounded-lg transition-colors",
        "hover:bg-accent hover:text-accent-foreground",
        isActive && "bg-accent text-accent-foreground",
      )}
      onClick={onClick}
    >
      <div className="flex items-start gap-2">
        <MessageSquare className="h-4 w-4 mt-0.5 shrink-0" />
        <div className="flex-1 min-w-0">
          <div className="font-medium truncate">{session.title}</div>
          <div className="text-xs text-muted-foreground truncate mt-1">{preview}</div>
        </div>
        <div className="text-xs text-muted-foreground shrink-0">
          {formatTime(session.updatedAt)}
        </div>
      </div>
    </button>
  );
}
