'use client';

import { useMemo } from 'react';
import { useTranslations } from 'next-intl';
import { FileDiff, FileText } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { openFilePreview, type PaneTab } from '@/stores/pane-store';
import { parseUnifiedDiff } from '@/lib/diff-view';
import { cn } from '@/lib/utils';

/**
 * The right pane's diff tab: one file's unified diff for one turn.
 *
 * The body travels in the tab payload because the write tool captured it at
 * edit time and the transcript persists it — this view never asks the server,
 * so a reload and a replay show exactly what was changed.
 */
export function FileDiffTab({ tab }: { tab: PaneTab }) {
  if (tab.kind !== 'file-diff') return null;
  return (
    <FileDiffBody
      key={`${tab.turn}:${tab.path}`}
      path={tab.path}
      projectId={tab.projectId}
      diff={tab.diff}
      additions={tab.additions}
      deletions={tab.deletions}
      edits={tab.edits}
      truncated={tab.truncated === true}
    />
  );
}

function FileDiffBody({
  path,
  projectId,
  diff,
  additions,
  deletions,
  edits,
  truncated,
}: {
  path: string;
  projectId: string;
  diff: string;
  additions: number;
  deletions: number;
  edits: number;
  truncated: boolean;
}) {
  const t = useTranslations('pane');
  const rows = useMemo(() => parseUnifiedDiff(diff), [diff]);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex shrink-0 items-center gap-2 border-b px-3 py-1.5">
        <FileDiff className="text-muted-foreground h-3.5 w-3.5 shrink-0" aria-hidden />
        <span
          className="text-muted-foreground min-w-0 flex-1 truncate font-mono text-[11px]"
          title={path}
        >
          {path}
        </span>
        <span className="flex shrink-0 items-baseline gap-1.5 font-mono text-[11px]">
          <span className="text-success">+{additions}</span>
          <span className="text-destructive">-{deletions}</span>
        </span>
        {edits > 1 && (
          <span className="text-muted-foreground shrink-0 text-[10px]">
            {t('diff.edits', { count: edits })}
          </span>
        )}
        {projectId !== '' && (
          <Button
            variant="ghost"
            size="icon"
            className="h-6 w-6 shrink-0"
            aria-label={t('diff.openFile')}
            title={t('diff.openFile')}
            onClick={() => openFilePreview(projectId, path)}
          >
            <FileText className="h-3.5 w-3.5" />
          </Button>
        )}
      </div>
      {truncated && (
        <div className="bg-muted/60 text-muted-foreground shrink-0 border-b px-3 py-1.5 text-xs">
          {t('diff.truncated')}
        </div>
      )}
      <div className="min-h-0 flex-1 overflow-auto py-1" data-testid="diff-rows">
        {rows.length === 0 ? (
          <div className="text-muted-foreground p-4 text-sm">{t('diff.empty')}</div>
        ) : (
          rows.map((row, index) =>
            row.kind === 'hunk' ? (
              <div
                key={`h${index}`}
                className="text-muted-foreground/70 bg-muted/40 px-3 py-1 font-mono text-[11px] whitespace-pre"
              >
                {row.text}
              </div>
            ) : (
              <div
                key={`l${index}`}
                data-kind={row.kind}
                className={cn(
                  'flex w-max min-w-full font-mono text-xs leading-5',
                  row.kind === 'add' && 'bg-success/10',
                  row.kind === 'remove' && 'bg-destructive/10',
                )}
              >
                <DiffGutter value={row.oldLine} />
                <DiffGutter value={row.newLine} />
                <span
                  aria-hidden
                  className={cn(
                    'w-4 shrink-0 px-1 select-none',
                    row.kind === 'add' && 'text-success',
                    row.kind === 'remove' && 'text-destructive',
                    row.kind === 'context' && 'text-muted-foreground/50',
                  )}
                >
                  {row.kind === 'add' ? '+' : row.kind === 'remove' ? '-' : ' '}
                </span>
                <code className="flex-1 px-2 whitespace-pre">{row.text}</code>
              </div>
            ),
          )
        )}
      </div>
    </div>
  );
}

/** One side's line number; a blank cell keeps the two columns aligned. */
function DiffGutter({ value }: { value?: number }) {
  return (
    <span
      aria-hidden
      className="text-muted-foreground/60 sticky left-0 z-[1] w-10 shrink-0 bg-inherit px-2 text-right text-[11px] select-none"
    >
      {value ?? ''}
    </span>
  );
}