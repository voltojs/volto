/**
 * Volto Desktop App
 * Electron + React + Tailwind CSS + shadcn/ui
 */

import { AppLayout } from "@/renderer/src/components/layout/AppLayout";
import { Sidebar } from "@/renderer/src/components/layout/Sidebar";
import { ChatPanel } from "@/renderer/src/components/chat/ChatPanel";
import { useChatStore } from "@/renderer/src/stores/chat-store";

function App() {
  const { isLoading, error } = useChatStore();

  return (
    <AppLayout
      sidebar={<Sidebar />}
      statusBar={
        <div className="flex items-center justify-between w-full">
          <div className="flex items-center gap-2">
            {isLoading && (
              <div className="flex items-center gap-1">
                <div className="h-2 w-2 rounded-full bg-yellow-500 animate-pulse" />
                <span>处理中...</span>
              </div>
            )}
            {error && (
              <div className="flex items-center gap-1 text-destructive">
                <div className="h-2 w-2 rounded-full bg-destructive" />
                <span>{error}</span>
              </div>
            )}
            {!isLoading && !error && (
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
    </AppLayout>
  );
}

export default App;
