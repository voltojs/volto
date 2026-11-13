'use client';

import type { ConversationBlock, ConversationMessage } from '@voltojs/sdk/sse';
import type { RefAnnotation } from '@voltojs/sdk/file-refs';
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
  fileProjectId,
  blockRefs,
}: {
  blocks: Array<Extract<ConversationBlock, { type: 'text' | 'image' }>>;
  sessionId?: string | null;
  /** The message this row ends, when it is that message's last row. */
  footer?: ConversationMessage | null;
  /**
   * Project the content belongs to (undefined → current session at click
   * time). Sub-agent feeds pass their parent's project explicitly.
   */
  fileProjectId?: string | null;
  /** Per-block ref annotations from the host (index-aligned with blocks). */
  blockRefs?: RefAnnotation[][];
}) {
  return (
    <div className="animate-in-stagger py-0.5">
      {blocks.length > 0 && (
        <div className="space-y-2">
          {blocks.map((block, index) =>
            block.type === 'image' ? (
              <AttachmentImage key={index} block={block} sessionId={sessionId} />
            ) : (
              <Markdown
                key={index}
                content={block.text}
                projectId={fileProjectId}
                refs={blockRefs?.[index]}
              />
            ),
          )}
        </div>
      )}
      {footer !== null && footer !== undefined && <MessageFooter message={footer} />}
    </div>
  );
}
