/**
 * Volto Desktop App
 * Electron + React + Tailwind CSS + shadcn/ui
 */

import { useEffect } from "react";
import { AppLayout } from "@/renderer/src/components/layout/AppLayout";
import { Sidebar } from "@/renderer/src/components/layout/Sidebar";
import { ChatPanel } from "@/renderer/src/components/chat/ChatPanel";
import { ApprovalDialog } from "@/renderer/src/components/approval/ApprovalDialog";
import { useChatStore } from "@/renderer/src/stores/chat-store";
import { useStream } from "@/renderer/src/hooks/use-stream";

function App() {
  const { isLoading, error, hydrateFromStore, hydrated } = useChatStore();

  // 启动时从主进程持久层加载会话历史；只跑一次
  useEffect(() => {
    void hydrateFromStore();
  }, [hydrateFromStore]);

  // 订阅主进程 EventSink → chat-store 的桥接；整个 app 仅一份订阅
  useStream();

  return (
    <AppLayout
      sidebar={<Sidebar />}
      statusBar={
        <div className="flex items-center justify-between w-full">
          <div className="flex items-center gap-2">
            {!hydrated && (
              <div className="flex items-center gap-1">
                <div className="h-2 w-2 rounded-full bg-blue-500 animate-pulse" />
                <span>加载会话...</span>
              </div>
            )}
            {hydrated && isLoading && (
              <div className="flex items-center gap-1">
                <div className="h-2 w-2 rounded-full bg-yellow-500 animate-pulse" />
                <span>处理中...</span>
              </div>
            )}
            {hydrated && error && (
              <div className="flex items-center gap-1 text-destructive">
                <div className="h-2 w-2 rounded-full bg-destructive" />
                <span>{error}</span>
              </div>
            )}
            {hydrated && !isLoading && !error && (
              <div className="flex items-center gap-1">
                <div className="h-2 w-2 rounded-full bg-green-500" />
                <span>就绪</span>
              </div>
            )}
          </div>
          <div className="text-muted-foreground">
            {window.electronAPI?.app?.platform ?? "unknown"}
          </div>
        </div>
      }
    >
      <ChatPanel />
      {/* 全局审批弹窗：用 ApprovalGate 推来的请求驱动，挂在 App 根以确保任意路由下都能弹出 */}
      <ApprovalDialog />
    </AppLayout>
  );
}

export default App;
