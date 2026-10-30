'use client';

import type { ConversationBlock, ConversationMessage } from '@volto/sdk/sse';
import { AttachmentImage } from './AttachmentImage';
import { Markdown } from './Markdown';
import { MessageFooter } from './MessageFooter';

/**
 * One stretch of the model's answer, rendered as prose.
 *
 * A turn's text can arrive between two tool runs, so the answer is no longer
 * "the bubble that owns the message": each text segment is its own row and
 * the execution around it folds away separately.
 */
export function AnswerRow({
  blocks,
  sessionId,
  footer,
}: {
  blocks: Array<Extract<ConversationBlock, { type: 'text' | 'image' }>>;
  sessionId?: string | null;
  /** The message this row ends, when it is that message's last row. */
  footer?: ConversationMessage | null;
}) {
  return (
    <div className="animate-in-stagger py-0.5">
      {blocks.length > 0 && (
        <div className="space-y-2">
          {blocks.map((block, index) =>
            block.type === 'image' ? (
              <AttachmentImage key={index} block={block} sessionId={sessionId} />
            ) : (
              <Markdown key={index} content={block.text} />
            ),
          )}
        </div>
      )}
      {footer !== null && footer !== undefined && <MessageFooter message={footer} />}
    </div>
  );
}
