'use client';

import { Sidebar } from '@/components/sidebar/Sidebar';
import { SidebarToggle } from '@/components/sidebar/SidebarToggle';
import { ChatPanel } from '@/components/chat/ChatPanel';

export default function Home() {
  return (
    <div className="flex h-screen bg-white">
      {/* Sidebar */}
      <Sidebar />

      {/* Main Content */}
      <div className="flex-1 flex flex-col min-w-0">
        {/* Header */}
        <header className="flex items-center gap-3 px-4 py-3 border-b">
          <SidebarToggle />
          <h1 className="text-lg font-semibold">Volto</h1>
        </header>

        {/* Chat Area */}
        <div className="flex-1 overflow-hidden">
          <ChatPanel />
        </div>
      </div>
    </div>
  );
}
