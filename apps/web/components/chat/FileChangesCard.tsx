'use client';

import { FileCode } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { openFileDiffTab } from '@/stores/pane-store';
import { currentProjectId } from '@/lib/open-file-ref';
import { useConfigStore } from '@/stores/config-store';
import type { TurnFileChange } from '@/lib/turn-file-changes';

interface FileChangesCardProps {
  /** The turn whose edits this card summarises (message-id turn prefix). */
  turn: string;
  changes: readonly TurnFileChange[];
  /**
   * Project the paths are relative to. `undefined` resolves to the current
   * session's project at click time (the main feed always belongs to it);
   * `null` means the owner is unknown and the diff opens without one.
   */
  projectId?: string | null;
}

/**
 * The turn's edit summary, rendered at the end of the turn the way a coding
 * agent reports "edited N files": totals on the header row, one clickable row
 * per file. A row opens the file's diff in the right pane.
 *
 * Counts are the sum over the whole turn (a file edited three times reports
 * every added/removed line once); the body is the concatenated per-edit
 * diffs, which is why the pane renders hunks rather than a single patch.
 */
/**
 * Strip a project root prefix off a path the model spelled absolutely, so the
 * diff tab's "open file" action targets the same project-relative file the
 * preview endpoint expects. Relative paths pass through untouched.
 */
function projectRelative(projectId: string | null, path: string): string {
  if (projectId === null) return path;
  const root = useConfigStore.getState().projects.find((p) => p.id === projectId)?.path;
  if (root === undefined || root === '') return path;
  const prefix = root.endsWith('/') ? root : `${root}/`;
  return path.startsWith(prefix) ? path.slice(prefix.length) : path;
}

export function FileChangesCard({ turn, changes, projectId }: FileChangesCardProps) {
  const t = useTranslations('chat');
  const additions = changes.reduce((sum, change) => sum + change.additions, 0);
  const deletions = changes.reduce((sum, change) => sum + change.deletions, 0);

  return (
    <div
      className="my-2 overflow-hidden rounded-lg border"
      data-testid="file-changes-card"
      data-turn={turn}
    >
      <div
        className="bg-muted/30 flex items-center gap-2.5 px-3 py-2"
        data-testid="file-changes-summary"
      >
        <span className="bg-primary/10 text-primary flex h-7 w-7 shrink-0 items-center justify-center rounded-md">
          <FileCode className="h-4 w-4" aria-hidden />
        </span>
        <span className="text-sm font-medium">
          {t('fileChanges.title', { count: changes.length })}
        </span>
        <span className="ml-auto flex shrink-0 items-baseline gap-1.5 font-mono text-xs">
          <span className="text-success">+{additions}</span>
          <span className="text-destructive">-{deletions}</span>
        </span>
      </div>
      <div className="divide-y border-t">
        {changes.map((change) => (
          <button
            key={change.path}
            type="button"
            title={change.path}
            aria-label={t('fileChanges.open', { path: change.path })}
            onClick={() => {
              const pid = projectId === undefined ? currentProjectId() : projectId;
              openFileDiffTab({
                projectId: pid ?? '',
                path: projectRelative(pid, change.path),
                turn,
                diff: change.diff,
                additions: change.additions,
                deletions: change.deletions,
                edits: change.edits,
                ...(change.truncated === true ? { truncated: true } : {}),
              });
            }}
            className="hover:bg-muted/50 flex w-full items-center gap-3 px-3 py-2 text-left transition-colors"
          >
            <span className="text-muted-foreground min-w-0 flex-1 truncate font-mono text-xs">
              {change.path}
            </span>
            {change.truncated === true && (
              <span className="text-muted-foreground/70 shrink-0 text-[10px]">
                {t('fileChanges.truncated')}
              </span>
            )}
            <span className="flex shrink-0 items-baseline gap-1.5 font-mono text-xs">
              <span className="text-success">+{change.additions}</span>
              <span className="text-destructive">-{change.deletions}</span>
            </span>
          </button>
        ))}
      </div>
    </div>
  );
}