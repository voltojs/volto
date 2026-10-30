'use client';

import type { ConversationBlock, ConversationMessage } from '@volto/sdk/sse';
import { AttachmentImage } from './AttachmentImage';

type ImageBlock = Extract<ConversationBlock, { type: 'image' }>;

interface MessageBubbleProps {
  message: ConversationMessage;
  /**
   * Session whose attachment store holds any images this bubble references.
   * Without it the image src is skipped — a request with no sessionId is a
   * guaranteed 400 on the gateway.
   */
  sessionId?: string | null;
}

/**
 * A human turn: right-aligned bubble, text plus any attachments.
 *
 * Assistant messages no longer render here — the feed splits them into
 * answer rows and execution groups (see lib/feed-groups.ts), because a single
 * message can interleave text with tool calls.
 */
export function MessageBubble({ message, sessionId }: MessageBubbleProps) {
  // `content` is the concatenated text (clipboard surface); image refs live
  // only in `blocks`, so they need their own render path here.
  const images = message.blocks.filter((b): b is ImageBlock => b.type === 'image');
  return (
    <div className="animate-in-stagger flex justify-end py-2">
      <div className="bg-primary/10 text-foreground max-w-[85%] space-y-2 rounded-2xl rounded-br-md px-3.5 py-2 text-sm">
        {message.content !== '' && (
          <div className="whitespace-pre-wrap">{message.content}</div>
        )}
        {images.map((block, i) => (
          <AttachmentImage
            key={`${block.attachmentId}:${i}`}
            block={block}
            sessionId={sessionId}
          />
        ))}
      </div>
    </div>
  );
}
