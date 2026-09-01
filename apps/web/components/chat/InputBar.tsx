'use client';

import { useState, type FormEvent } from 'react';
import { Button } from '@/components/ui/button';

interface InputBarProps {
  onSubmit?: (message: string) => void;
  disabled?: boolean;
}

export function InputBar({ onSubmit, disabled }: InputBarProps) {
  const [input, setInput] = useState('');

  const handleSubmit = (e: FormEvent) => {
    e.preventDefault();
    if (input.trim() && !disabled) {
      onSubmit?.(input.trim());
      setInput('');
    }
  };

  return (
    <form onSubmit={handleSubmit} className="flex gap-2 p-4 border-t">
      <input
        type="text"
        value={input}
        onChange={(e) => setInput(e.target.value)}
        placeholder="Type a message..."
        disabled={disabled}
        className="flex-1 px-4 py-2 border rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500 disabled:opacity-50"
      />
      <Button type="submit" disabled={!input.trim() || disabled}>
        Send
      </Button>
    </form>
  );
}
