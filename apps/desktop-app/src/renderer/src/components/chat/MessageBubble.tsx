/**
 * MessageBubble
 * 消息气泡：用户消息 / assistant 消息
 */

import { User, Bot } from "lucide-react";
import { Avatar, AvatarFallback } from "@/renderer/src/components/ui/avatar";
import { cn } from "@/renderer/src/lib/utils";
import type { Message } from "@/renderer/src/stores/chat-store";
import { ToolCallCard } from "./ToolCallCard";
import { StreamRenderer } from "./StreamRenderer";

/** MessageBubble 属性 */
export interface MessageBubbleProps {
  /** 消息数据 */
  message: Message;
  /** 自定义类名 */
  className?: string;
}

/**
 * MessageBubble 组件
 * 根据消息角色显示不同的样式
 */
export function MessageBubble({ message, className }: MessageBubbleProps) {
  const isUser = message.role === "user";
  const isAssistant = message.role === "assistant";

  /** 格式化时间 */
  const formatTime = (timestamp: number) => {
    return new Date(timestamp).toLocaleTimeString("zh-CN", {
      hour: "2-digit",
      minute: "2-digit",
    });
  };

  return (
    <div
      className={cn(
        "flex gap-3",
        isUser ? "flex-row-reverse" : "flex-row",
        className,
      )}
    >
      {/* 头像 */}
      <Avatar className="h-8 w-8 shrink-0">
        <AvatarFallback
          className={cn(
            isUser ? "bg-primary text-primary-foreground" : "bg-muted",
          )}
        >
          {isUser ? <User className="h-4 w-4" /> : <Bot className="h-4 w-4" />}
        </AvatarFallback>
      </Avatar>

      {/* 消息内容 */}
      <div
        className={cn(
          "flex flex-col gap-1 max-w-[80%]",
          isUser ? "items-end" : "items-start",
        )}
      >
        {/* 消息气泡 */}
        <div
          className={cn(
            "rounded-lg px-4 py-2 text-sm",
            isUser
              ? "bg-primary text-primary-foreground"
              : "bg-muted",
          )}
        >
          {isAssistant && message.isStreaming ? (
            <StreamRenderer content={message.content} />
          ) : (
            <div className="whitespace-pre-wrap break-words">{message.content}</div>
          )}
        </div>

        {/* 工具调用 */}
        {message.toolCalls && message.toolCalls.length > 0 && (
          <div className="w-full space-y-2 mt-2">
            {message.toolCalls.map((toolCall) => (
              <ToolCallCard key={toolCall.id} toolCall={toolCall} />
            ))}
          </div>
        )}

        {/* 时间戳 */}
        <div className="text-xs text-muted-foreground px-1">
          {formatTime(message.timestamp)}
        </div>
      </div>
    </div>
  );
}
