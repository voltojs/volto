'use client';

import { useState, type FormEvent, type KeyboardEvent, type ReactNode } from 'react';
import { ArrowUp } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { Kbd } from '@/components/ui/kbd';

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
    <form onSubmit={handleSubmit} className="mx-auto w-full max-w-3xl px-6 pb-4">
      <div className="rounded-xl border bg-card shadow-sm transition-shadow focus-within:border-ring focus-within:ring-3 focus-within:ring-ring/30">
        <Textarea
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder={placeholder ?? '描述你想要构建的内容…'}
          disabled={disabled}
          rows={1}
          className="max-h-48 min-h-11 resize-none border-0 px-3.5 py-3 text-sm shadow-none focus-visible:ring-0"
        />
        <div className="flex items-center gap-2 px-2.5 pb-2.5">
          {toolbar}
          <span className="ml-auto hidden items-center gap-1 text-[11px] text-muted-foreground sm:flex">
            <Kbd>Enter</Kbd> 发送 <Kbd>Shift+Enter</Kbd> 换行
          </span>
          <Button
            type="submit"
            size="icon"
            className="h-8 w-8 shrink-0 rounded-full"
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
