'use client';

import {
  useState,
  type FormEvent,
  type KeyboardEvent,
  type ReactNode,
} from 'react';
import { ArrowUp, Square } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';

interface InputBarProps {
  onSubmit?: (message: string) => void;
  disabled?: boolean;
  placeholder?: string;
  /** Controls on the left of the toolbar (permission / project pickers). */
  toolbar?: ReactNode;
  /** Controls immediately left of the send button (context meter, model picker). */
  trailing?: ReactNode;
  /**
   * True while a turn is streaming: the send button becomes a stop button.
   * Note this is independent of `disabled` — the stop button stays clickable
   * while the textarea is locked.
   */
  isGenerating?: boolean;
  /** Invoked by the stop button. Omit to keep the send button while generating. */
  onStop?: () => void;
}

export function InputBar({
  onSubmit,
  disabled,
  placeholder,
  toolbar,
  trailing,
  isGenerating,
  onStop,
}: InputBarProps) {
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

  const showStop = Boolean(isGenerating && onStop);

  return (
    <form onSubmit={handleSubmit} className="mx-auto w-full max-w-3xl px-6 pb-4">
      <div className="bg-card focus-within:border-ring focus-within:ring-ring/30 rounded-xl border shadow-sm transition-shadow focus-within:ring-3">
        <Textarea
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder={placeholder ?? '描述你想要构建的内容…'}
          disabled={disabled}
          rows={1}
          className="max-h-48 min-h-11 resize-none border-0 px-3.5 py-3 text-sm shadow-none focus-visible:ring-0"
        />
        <div className="flex items-center gap-1 px-2.5 pb-2.5">
          {toolbar}
          <div className="ml-auto flex items-center gap-1">
            {trailing}
            {showStop ? (
              // Deliberately not gated on `disabled`: the textarea is locked
              // while a turn streams, but stopping that turn is exactly what
              // the user needs to be able to do then.
              <Button
                type="button"
                size="icon"
                variant="destructive"
                className="h-8 w-8 shrink-0 rounded-full"
                onClick={onStop}
                aria-label="中断生成"
              >
                <Square className="h-3.5 w-3.5 fill-current" />
              </Button>
            ) : (
              <Button
                type="submit"
                size="icon"
                className="h-8 w-8 shrink-0 rounded-full"
                disabled={!input.trim() || disabled}
                aria-label="发送"
              >
                <ArrowUp className="h-4 w-4" />
              </Button>
            )}
          </div>
        </div>
      </div>
    </form>
  );
}
