'use client';

import { useState, type FormEvent, type KeyboardEvent, type ReactNode } from 'react';
import { ArrowUp } from 'lucide-react';
import { Button } from '@/components/ui/button';

interface InputBarProps {
  onSubmit?: (message: string) => void;
  disabled?: boolean;
  placeholder?: string;
  /** Controls rendered under the textarea (model / permission pickers). */
  toolbar?: ReactNode;
}

export function InputBar({ onSubmit, disabled, placeholder, toolbar }: InputBarProps) {
  const [input, setInput] = useState('');

  const submit = () => {
    if (!input.trim() || disabled) return;
    onSubmit?.(input.trim());
    setInput('');
  };

  const handleSubmit = (e: FormEvent) => {
    e.preventDefault();
    submit();
  };

  const handleKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    // Enter sends; Shift+Enter inserts a newline. A textarea has no implicit
    // form submission, so this has to be explicit.
    // Skip while an IME composition is active: confirming a candidate word
    // (e.g. Chinese/Japanese/Korean input methods) also fires a keydown with
    // key === 'Enter', and without this guard it would send the
    // half-composed text instead of just confirming the candidate.
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      submit();
    }
  };

  return (
    <form onSubmit={handleSubmit} className="p-4">
      <div className="rounded-xl border focus-within:ring-2 focus-within:ring-blue-500">
        <textarea
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder={placeholder ?? '描述你想要构建的内容…'}
          disabled={disabled}
          rows={2}
          className="w-full resize-none bg-transparent px-4 py-3 text-sm outline-none disabled:opacity-50"
        />
        <div className="flex items-center gap-2 px-2 pb-2">
          {toolbar}
          <Button
            type="submit"
            size="icon"
            className="ml-auto h-8 w-8 rounded-full"
            disabled={!input.trim() || disabled}
            aria-label="发送"
          >
            <ArrowUp className="h-4 w-4" />
          </Button>
        </div>
      </div>
    </form>
  );
}
