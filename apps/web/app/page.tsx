'use client';

import { ChatPanel } from '@/components/chat/ChatPanel';

export default function Home() {
  return (
    <main className="flex h-screen flex-col">
      <header className="flex items-center justify-between px-6 py-4 border-b">
        <h1 className="text-xl font-bold">Volto Web</h1>
      </header>
      <div className="flex-1 overflow-hidden">
        <ChatPanel />
      </div>
    </main>
  );
}
