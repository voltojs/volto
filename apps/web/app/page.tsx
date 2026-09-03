'use client';

import { Sidebar } from '@/components/sidebar/Sidebar';
import { ChatPanel } from '@/components/chat/ChatPanel';

export default function Home() {
  return (
    <div className="bg-background flex h-screen">
      <Sidebar />
      <div className="flex min-w-0 flex-1 flex-col">
        <ChatPanel />
      </div>
    </div>
  );
}
