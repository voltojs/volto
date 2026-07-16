/**
 * ChatPanel
 * 对话主面板：消息列表 + 输入框
 */

import { useState, useRef, useEffect, useCallback } from "react";
import { Send, Loader2 } from "lucide-react";
import { Button } from "@/renderer/src/components/ui/button";
import { Textarea } from "@/renderer/src/components/ui/textarea";
import { ScrollArea } from "@/renderer/src/components/ui/scroll-area";
import { cn } from "@/renderer/src/lib/utils";
import { useChatStore } from "@/renderer/src/stores/chat-store";
import { useAgent } from "@/renderer/src/hooks/use-agent";
import { MessageBubble } from "./MessageBubble";

/** ChatPanel 属性 */
export interface ChatPanelProps {
  /** 自定义类名 */
  className?: string;
}

/**
 * ChatPanel 组件
 * 显示消息列表和输入框
 */
export function ChatPanel({ className }: ChatPanelProps) {
  const [input, setInput] = useState("");
  const scrollRef = useRef<HTMLDivElement>(null);
  const { currentSessionId, getCurrentMessages, addMessage, createSession, isLoading, setLoading, setError } =
    useChatStore();
  const { sendMessage } = useAgent();

  /** 获取当前消息 */
  const messages = getCurrentMessages();

  /** 自动滚动到底部 */
  const scrollToBottom = useCallback(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, []);

  /** 消息变化时滚动到底部 */
  useEffect(() => {
    scrollToBottom();
  }, [messages, scrollToBottom]);

  /** 发送消息 */
  const handleSend = async () => {
    const trimmedInput = input.trim();
    if (!trimmedInput || isLoading) return;

    // 确保有当前会话
    let sessionId = currentSessionId;
    if (!sessionId) {
      sessionId = createSession();
    }

    // 添加用户消息
    const userMessage = {
      id: Date.now().toString(),
      role: "user" as const,
      content: trimmedInput,
      timestamp: Date.now(),
    };
    addMessage(sessionId, userMessage);

    // 清空输入框
    setInput("");

    // 发送到 agent
    setLoading(true);
    setError(null);
    try {
      await sendMessage(trimmedInput);
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      setError(errorMessage);

      // 添加错误消息
      const errorMsg = {
        id: (Date.now() + 1).toString(),
        role: "assistant" as const,
        content: `错误: ${errorMessage}`,
        timestamp: Date.now(),
      };
      addMessage(sessionId, errorMsg);
    } finally {
      setLoading(false);
    }
  };

  /** 处理键盘事件 */
  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  return (
    <div className={cn("flex flex-col h-full", className)}>
      {/* 消息列表 */}
      <ScrollArea className="flex-1 p-4" ref={scrollRef}>
        <div className="space-y-4 max-w-3xl mx-auto">
          {messages.map((message) => (
            <MessageBubble key={message.id} message={message} />
          ))}

          {messages.length === 0 && (
            <div className="text-center py-16">
              <h2 className="text-2xl font-semibold mb-2">开始对话</h2>
              <p className="text-muted-foreground">输入消息开始与 AI Agent 交流</p>
            </div>
          )}
        </div>
      </ScrollArea>

      {/* 输入框 */}
      <div className="border-t p-4">
        <div className="max-w-3xl mx-auto flex gap-2">
          <Textarea
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="输入消息... (Enter 发送, Shift+Enter 换行)"
            className="min-h-[60px] max-h-[200px] resize-none"
            disabled={isLoading}
          />
          <Button
            onClick={handleSend}
            disabled={!input.trim() || isLoading}
            className="shrink-0"
          >
            {isLoading ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <Send className="h-4 w-4" />
            )}
          </Button>
        </div>
      </div>
    </div>
  );
}
