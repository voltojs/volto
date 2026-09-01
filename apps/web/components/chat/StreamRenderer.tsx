'use client';

interface StreamRendererProps {
  content: string;
}

export function StreamRenderer({ content }: StreamRendererProps) {
  return (
    <div className="whitespace-pre-wrap">
      {content}
      <span className="inline-block w-2 h-4 ml-1 bg-current animate-pulse" />
    </div>
  );
}
