'use client';

import { MessageList } from './MessageList';
import { InputBar } from './InputBar';

export function ChatPanel() {
  return (
    <div className="flex flex-col h-full">
      <MessageList />
      <InputBar />
    </div>
  );
}
