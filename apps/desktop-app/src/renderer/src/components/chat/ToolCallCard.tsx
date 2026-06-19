/**
 * ToolCallCard
 * 工具调用卡片：名称、参数、结果、耗时，可折叠
 */

import { useState } from "react";
import { ChevronDown, ChevronRight, Wrench, CheckCircle, XCircle, Clock } from "lucide-react";
import { Badge } from "@/renderer/src/components/ui/badge";
import { cn } from "@/renderer/src/lib/utils";
import type { ToolCall } from "@/renderer/src/stores/chat-store";

/** ToolCallCard 属性 */
export interface ToolCallCardProps {
  /** 工具调用数据 */
  toolCall: ToolCall;
  /** 自定义类名 */
  className?: string;
}

/**
 * ToolCallCard 组件
 * 显示工具调用的详细信息
 */
export function ToolCallCard({ toolCall, className }: ToolCallCardProps) {
  const [isExpanded, setIsExpanded] = useState(false);

  /** 格式化耗时 */
  const formatDuration = (ms?: number) => {
    if (!ms) return null;
    if (ms < 1000) return `${ms}ms`;
    return `${(ms / 1000).toFixed(1)}s`;
  };

  /** 格式化 JSON */
  const formatJSON = (data: unknown) => {
    try {
      return JSON.stringify(data, null, 2);
    } catch {
      return String(data);
    }
  };

  /** 是否有错误 */
  const hasError = !!toolCall.error;

  /** 是否已完成 */
  const isCompleted = toolCall.result !== undefined || hasError;

  return (
    <div
      className={cn(
        "rounded-lg border bg-card text-card-foreground shadow-sm",
        hasError && "border-destructive",
        className,
      )}
    >
      {/* 头部 */}
      <button
        className="w-full flex items-center gap-2 p-3 hover:bg-accent/50 transition-colors"
        onClick={() => setIsExpanded(!isExpanded)}
      >
        {/* 展开/折叠图标 */}
        {isExpanded ? (
          <ChevronDown className="h-4 w-4 shrink-0" />
        ) : (
          <ChevronRight className="h-4 w-4 shrink-0" />
        )}

        {/* 工具图标 */}
        <Wrench className="h-4 w-4 shrink-0 text-muted-foreground" />

        {/* 工具名称 */}
        <span className="font-medium text-sm">{toolCall.name}</span>

        {/* 状态徽章 */}
        <div className="ml-auto flex items-center gap-2">
          {toolCall.duration && (
            <Badge variant="outline" className="text-xs gap-1">
              <Clock className="h-3 w-3" />
              {formatDuration(toolCall.duration)}
            </Badge>
          )}

          {isCompleted && (
            <Badge
              variant={hasError ? "destructive" : "default"}
              className="text-xs gap-1"
            >
              {hasError ? (
                <XCircle className="h-3 w-3" />
              ) : (
                <CheckCircle className="h-3 w-3" />
              )}
              {hasError ? "失败" : "成功"}
            </Badge>
          )}
        </div>
      </button>

      {/* 详情 */}
      {isExpanded && (
        <div className="border-t p-3 space-y-3">
          {/* 参数 */}
          {toolCall.args && Object.keys(toolCall.args).length > 0 && (
            <div>
              <div className="text-xs font-medium text-muted-foreground mb-1">
                参数
              </div>
              <pre className="text-xs bg-muted p-2 rounded-md overflow-x-auto">
                {formatJSON(toolCall.args)}
              </pre>
            </div>
          )}

          {/* 结果 */}
          {toolCall.result !== undefined && (
            <div>
              <div className="text-xs font-medium text-muted-foreground mb-1">
                结果
              </div>
              <pre className="text-xs bg-muted p-2 rounded-md overflow-x-auto max-h-[200px] overflow-y-auto">
                {formatJSON(toolCall.result)}
              </pre>
            </div>
          )}

          {/* 错误 */}
          {toolCall.error && (
            <div>
              <div className="text-xs font-medium text-destructive mb-1">
                错误
              </div>
              <pre className="text-xs bg-destructive/10 text-destructive p-2 rounded-md overflow-x-auto">
                {toolCall.error}
              </pre>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
