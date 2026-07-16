/**
 * AppLayout
 * 整体布局：侧边栏 + 主面板 + 状态栏
 */

import { type ReactNode } from "react";
import { cn } from "@/renderer/src/lib/utils";

/** AppLayout 属性 */
export interface AppLayoutProps {
  /** 侧边栏内容 */
  sidebar: ReactNode;
  /** 主面板内容 */
  children: ReactNode;
  /** 状态栏内容 */
  statusBar?: ReactNode;
  /** 自定义类名 */
  className?: string;
}

/**
 * AppLayout 组件
 * 提供应用的整体布局结构
 */
export function AppLayout({ sidebar, children, statusBar, className }: AppLayoutProps) {
  return (
    <div className={cn("flex h-screen bg-background text-foreground", className)}>
      {/* 侧边栏 */}
      <aside className="w-64 border-r bg-muted/40 flex flex-col">{sidebar}</aside>

      {/* 主面板 */}
      <main className="flex-1 flex flex-col overflow-hidden">
        {/* 内容区域 */}
        <div className="flex-1 overflow-hidden">{children}</div>

        {/* 状态栏 */}
        {statusBar && (
          <footer className="h-8 border-t bg-muted/40 flex items-center px-4 text-xs text-muted-foreground">
            {statusBar}
          </footer>
        )}
      </main>
    </div>
  );
}
