'use client';

import { Markdown } from './Markdown';

interface StreamRendererProps {
  content: string;
}

export function StreamRenderer({ content }: StreamRendererProps) {
  return (
    <div>
      <Markdown content={content} />
      <span
        aria-hidden="true"
        className="caret-blink mt-0.5 inline-block h-3.5 w-[3px] rounded-full bg-primary align-middle"
      />
    </div>
  );
}
