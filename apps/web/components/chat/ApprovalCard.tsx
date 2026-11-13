'use client';

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { CircleHelp, ShieldAlert } from 'lucide-react';
import { classifyCommandRisk } from '@voltojs/sdk/sse';
import { Button } from '@/components/ui/button';
import { riskNoteKeyFor, rememberablePrefixes } from '@/lib/approvals';
import type { PendingApproval, ApprovalOutcome } from '@/lib/approvals';

interface ApprovalCardProps {
  approval: PendingApproval;
  onDecide: (
    callId: string,
    decision: 'allow' | 'deny',
    answer?: string[],
    remember?: { prefixTokens: number },
  ) => Promise<ApprovalOutcome | void>;
}

/**
 * The sole string argument of a tool call, when that is what the input is —
 * the common `bash` case. Returns undefined for anything else, which is what
 * keeps the rendered command and the risk notes describing the same thing:
 * both callers below read the command through this one function.
 *
 * Deliberately does not look up `input.command` by name: that would couple
 * this generic approval card to one tool's schema. A multi-field input (e.g.
 * `bash` with a `cwd` alongside `command`) falls back to JSON display and no
 * risk notes below — an accepted false negative, not a schema-specific reach.
 */
export function soleStringArg(input: Record<string, unknown>): string | undefined {
  const values = Object.values(input);
  return values.length === 1 && typeof values[0] === 'string' ? values[0] : undefined;
}

/**
 * Render the tool arguments for a human about to authorize them. A single
 * string argument (the common `bash` case) is shown raw so the command is
 * readable; anything else is pretty-printed JSON.
 */
function formatApprovalInput(input: Record<string, unknown>): string {
  return soleStringArg(input) ?? JSON.stringify(input, null, 2);
}

/**
 * Risk notes for the command being approved, derived from the SAME input the
 * card renders — never carried on the approval event, which deliberately
 * omits arguments so a second copy cannot drift from the one that executes.
 *
 * Routes through `soleStringArg`, the same extraction `formatApprovalInput`
 * uses, so the classified string and the displayed string can never diverge:
 * a multi-field input yields no notes rather than risk classifying whichever
 * field `Object.values` happens to put first.
 */
export function riskNotesFor(input: Record<string, unknown> | undefined): string[] {
  if (!input) return [];
  const command = soleStringArg(input);
  return command === undefined
    ? []
    : classifyCommandRisk(command).map(riskNoteKeyFor);
}

/**
 * The ask_user variant: options become radios (single-select) or checkboxes
 * (`multiSelect`), and a free-text box rides along in every shape — with
 * options as the spec's "其他" escape hatch, without them as the only input.
 *
 * The submitted answer merges the user's SELECTION ORDER first (click order
 * for checkboxes, not display order — the model sees what the user picked
 * first as the primary response) and appends the free text, matching the
 * `ApprovalResult.answer` contract the ask tool reads back.
 */
function AskUserForm({
  approval,
  busy,
  onSubmit,
  onSkip,
}: {
  approval: PendingApproval;
  busy: boolean;
  onSubmit: (answer: string[]) => void;
  onSkip: () => void;
}) {
  const t = useTranslations('chat');
  const [selected, setSelected] = useState<string[]>([]);
  const [freeText, setFreeText] = useState('');
  const options = approval.options ?? [];
  const multiSelect = approval.multiSelect === true;
  const trimmed = freeText.trim();
  const answer = [...selected, ...(trimmed ? [trimmed] : [])];

  return (
    <div className="mt-2">
      {approval.question && (
        <p className="text-sm whitespace-pre-wrap">{approval.question}</p>
      )}
      {options.length > 0 && (
        <div className="mt-2 space-y-1.5">
          {options.map((option) => (
            <label
              key={option.label}
              className="border-border/60 hover:bg-background/60 flex cursor-pointer items-start gap-2 rounded border p-2 text-sm"
            >
              <input
                type={multiSelect ? 'checkbox' : 'radio'}
                name={multiSelect ? undefined : `ask-user-${approval.callId}`}
                checked={selected.includes(option.label)}
                onChange={() =>
                  multiSelect
                    ? setSelected((prev) =>
                        prev.includes(option.label)
                          ? prev.filter((l) => l !== option.label)
                          : [...prev, option.label],
                      )
                    : setSelected([option.label])
                }
                className="accent-primary mt-0.5"
              />
              <span>
                {option.label}
                {option.description && (
                  <span className="text-muted-foreground ml-1.5 text-xs">
                    {option.description}
                  </span>
                )}
              </span>
            </label>
          ))}
        </div>
      )}
      <input
        type="text"
        value={freeText}
        onChange={(e) => setFreeText(e.target.value)}
        placeholder={t('approval.freeformPlaceholder')}
        className="border-input bg-background/60 focus-visible:border-ring focus-visible:ring-ring/30 mt-2 w-full rounded border px-2.5 py-1.5 text-sm outline-none focus-visible:ring-3"
      />
      <div className="mt-3 flex gap-2">
        <Button
          size="sm"
          disabled={busy || answer.length === 0}
          onClick={() => onSubmit(answer)}
        >
          {t('approval.submit')}
        </Button>
        <Button size="sm" variant="ghost" disabled={busy} onClick={onSkip}>
          {t('approval.skip')}
        </Button>
      </div>
    </div>
  );
}

/**
 * Rendered inline at the end of the feed rather than as a modal: approving a
 * tool call needs the surrounding context of what the agent was doing, and a
 * modal covers exactly that.
 */
export function ApprovalCard({ approval, onDecide }: ApprovalCardProps) {
  const t = useTranslations('chat');
  const [busy, setBusy] = useState(false);
  const [rememberSize, setRememberSize] = useState<number | null>(null);
  const [receipt, setReceipt] = useState<ApprovalOutcome | null>(null);

  const decide = async (
    decision: 'allow' | 'deny',
    answer?: string[],
    remember?: { prefixTokens: number },
  ) => {
    if (busy) return;
    setBusy(true);
    try {
      const outcome = await onDecide(approval.callId, decision, answer, remember);
      if (outcome) setReceipt(outcome);
    } finally {
      // The card disappears when the decision event lands; releasing here
      // covers the failure path, where it stays and must stay clickable.
      setBusy(false);
    }
  };

  if (approval.toolName === 'ask_user') {
    return (
      <div className="border-border bg-muted/40 rounded-lg border p-3">
        <div className="flex items-center gap-2 text-sm">
          <CircleHelp className="text-primary/80 h-4 w-4 shrink-0" />
          <span>{t('approval.needsAnswer')}</span>
        </div>
        <AskUserForm
          approval={approval}
          busy={busy}
          onSubmit={(answer) => void decide('allow', answer)}
          onSkip={() => void decide('deny')}
        />
      </div>
    );
  }

  const riskNotes = riskNotesFor(approval.input);

  return (
    <div className="border-border bg-muted/40 rounded-lg border p-3">
      <div className="flex items-center gap-2 text-sm">
        <ShieldAlert className="text-destructive/80 h-4 w-4 shrink-0" />
        <span>
          {t('approval.needsApproval')}
          <code className="font-mono">{approval.toolName}</code>
          <span className="text-muted-foreground ml-1 text-xs">
            ({approval.riskTier})
          </span>
        </span>
      </div>
      {approval.input !== undefined ? (
        <pre className="bg-background/60 text-muted-foreground mt-2 max-h-40 overflow-auto rounded border p-2 font-mono text-xs whitespace-pre-wrap">
          {formatApprovalInput(approval.input)}
        </pre>
      ) : (
        <p className="text-muted-foreground mt-2 text-xs">
          {t('approval.paramsMissing')}
        </p>
      )}
      {riskNotes.length > 0 ? (
        <ul className="text-destructive/90 mt-2 space-y-0.5 text-xs">
          {riskNotes.map((noteKey) => (
            <li key={noteKey}>· {t(noteKey)}</li>
          ))}
        </ul>
      ) : null}

      {(() => {
        const prefixes = rememberablePrefixes(approval);
        if (prefixes.length === 0) return null;
        const selected = rememberSize ?? prefixes.at(-1)?.length ?? 0;
        const selectedPrefix = prefixes.find((p) => p.length === selected);
        return (
          <fieldset className="mt-3 rounded border border-border/60 p-2">
            <legend className="px-1 text-xs">{t('approval.alwaysAllow')}</legend>
            <div className="space-y-1">
              {prefixes.map((prefix) => (
                <label key={prefix.join(' ')} className="flex items-center gap-2 font-mono text-xs">
                  <input
                    type="radio"
                    name={`remember-${approval.callId}`}
                    checked={selected === prefix.length}
                    onChange={() => setRememberSize(prefix.length)}
                    className="accent-primary mt-0.5"
                  />
                  {prefix.join(' ')}
                </label>
              ))}
            </div>
            <p className="text-muted-foreground mt-2 text-xs">
              {t('approval.willWrite')} <code>~/.volto/config.json</code>
              {t('approval.rulesPath')}：
              <code className="ml-1">{JSON.stringify({ toolName: 'bash', commandPrefix: selectedPrefix, decision: 'allow' })}</code>
              {t('approval.userLevel')}
            </p>
            <Button
              size="sm"
              variant="secondary"
              disabled={busy}
              className="mt-2"
              onClick={() => void decide('allow', undefined, { prefixTokens: selected })}
            >
              {t('approval.remember')}
            </Button>
          </fieldset>
        );
      })()}

      <div className="mt-3 flex gap-2">
        <Button size="sm" disabled={busy} onClick={() => void decide('allow')}>
          {t('approval.allowOnce')}
        </Button>
        <Button
          size="sm"
          variant="ghost"
          disabled={busy}
          onClick={() => void decide('deny')}
        >
          {t('approval.deny')}
        </Button>
      </div>

      {receipt?.remembered ? (
        <p className="text-muted-foreground mt-2 text-xs">
          {t('approval.saved')}<code>{JSON.stringify(receipt.remembered.rule)}</code>
          {receipt.remembered.outcome === 'covered' ? t('approval.covered') : ''}
          {t('approval.nextTurn')}
        </p>
      ) : null}
      {receipt?.rememberError ? (
        <p className="text-destructive/90 mt-2 text-xs">{t('approval.saveFailed', { error: receipt.rememberError })}</p>
      ) : null}
    </div>
  );
}
