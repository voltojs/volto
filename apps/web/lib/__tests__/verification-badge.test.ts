import { describe, expect, it } from 'vitest';
import { verificationBadge } from '../verification-badge';

describe('verificationBadge', () => {
  it('returns undefined without a verdict', () => {
    expect(verificationBadge((k) => k, undefined)).toBeUndefined();
  });
  it('reports a passed verdict', () => {
    expect(verificationBadge((k) => k, { status: 'passed', attempts: 1, failures: [] }))
      .toEqual({ badge: 'subagentCard.verified' });
  });
  it('reports failures with a count and reasons', () => {
    expect(verificationBadge((k, v) => `${k}:${JSON.stringify(v)}`, {
      status: 'failed', attempts: 2, failures: ['no tests'],
    })).toMatchObject({ badge: expect.stringContaining('verificationFailed'), warningDetail: expect.stringContaining('no tests') });
    // The badge already carries the count; the warning slot holds only the
    // reasons so the row never shows the same verdict twice.
    expect(verificationBadge((k) => k, { status: 'failed', attempts: 2, failures: [] }))
      .not.toHaveProperty('warning');
  });
  it('reports an unverifiable result distinctly', () => {
    expect(verificationBadge((k) => k, { status: 'error', attempts: 1, failures: [], verifierError: 'timeout' }))
      .toMatchObject({ badge: 'subagentCard.verificationError' });
    // The reason an error verdict carries is the verifier's own failure.
    expect(verificationBadge((k) => k, { status: 'error', attempts: 1, failures: [], verifierError: 'timeout' }))
      .toMatchObject({ warningDetail: 'timeout' });
  });
});
