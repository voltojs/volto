import type { ConversationToolCall } from '@voltojs/sdk/sse';

/** The rendered pieces a trace row shows for one acceptance verdict. */
export interface VerificationBadgeModel {
  badge: string;
  warning?: string;
  warningDetail?: string;
}

// Structural shape of next-intl's translator: keys are dotted paths inside the
// `chat` namespace. The values type matches what a real `t` accepts, so cards
// can hand their own `t` straight in.
type Translate = (
  key: string,
  values?: Record<string, string | number | Date>,
) => string;

/**
 * Map a dispatch's verification summary onto the row vocabulary: every verdict
 * has a badge; a failed or unverifiable one also carries `warningDetail` — the
 * reasons (joined with "、") or the verifier's own error — for the folded
 * warning slot. Returns undefined when no verdict exists so rows stay
 * untouched. `t` resolves keys relative to the `chat` namespace
 * (`subagentCard.verified`, ...).
 */
export function verificationBadge(
  t: Translate,
  verification: ConversationToolCall['verification'],
): VerificationBadgeModel | undefined {
  if (verification === undefined) return undefined;
  switch (verification.status) {
    case 'passed':
      return { badge: t('subagentCard.verified') };
    case 'failed':
      return {
        badge: t('subagentCard.verificationFailed', {
          count: verification.attempts,
        }),
        warningDetail: t('subagentCard.verificationFailures', {
          reasons: verification.failures.join('、'),
        }),
      };
    case 'error':
      return {
        badge: t('subagentCard.verificationError'),
        warningDetail: verification.verifierError,
      };
  }
}
