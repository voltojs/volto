/**
 * StreamRenderer
 * 流式文本渲染：Markdown 支持
 */

import { memo } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { cn } from "@/renderer/src/lib/utils";

/** StreamRenderer 属性 */
export interface StreamRendererProps {
  /** 文本内容 */
  content: string;
  /** 自定义类名 */
  className?: string;
}

/**
 * StreamRenderer 组件
 * 支持 Markdown 渲染的流式文本组件
 */
export const StreamRenderer = memo(function StreamRenderer({
  content,
  className,
}: StreamRendererProps) {
  return (
    <div className={cn("prose prose-sm dark:prose-invert max-w-none", className)}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          // 自定义代码块
          code({ className, children, ...props }) {
            const match = /language-(\w+)/.exec(className || "");
            const isInline = !match;

            if (isInline) {
              return (
                <code
                  className="bg-muted px-1.5 py-0.5 rounded text-sm"
                  {...props}
                >
                  {children}
                </code>
              );
            }

            return (
              <div className="relative">
                <div className="absolute top-2 right-2 text-xs text-muted-foreground">
                  {match[1]}
                </div>
                <pre className="bg-muted p-4 rounded-lg overflow-x-auto">
                  <code className={className} {...props}>
                    {children}
                  </code>
                </pre>
              </div>
            );
          },

          // 自定义链接
          a({ href, children, ...props }) {
            return (
              <a
                href={href}
                target="_blank"
                rel="noopener noreferrer"
                className="text-primary hover:underline"
                {...props}
              >
                {children}
              </a>
            );
          },

          // 自定义表格
          table({ children, ...props }) {
            return (
              <div className="overflow-x-auto">
                <table className="border-collapse" {...props}>
                  {children}
                </table>
              </div>
            );
          },

          // 自定义表头
          th({ children, ...props }) {
            return (
              <th
                className="border px-4 py-2 text-left font-medium bg-muted"
                {...props}
              >
                {children}
              </th>
            );
          },

          // 自定义单元格
          td({ children, ...props }) {
            return (
              <td className="border px-4 py-2" {...props}>
                {children}
              </td>
            );
          },
        }}
      >
        {content}
      </ReactMarkdown>
    </div>
  );
});
