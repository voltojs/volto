'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { ChevronDown, GitBranch as GitBranchIcon, Plus } from 'lucide-react';
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { cn } from '@/lib/utils';
import {
  checkoutGitBranch,
  createGitBranch,
  fetchGitSummary,
  searchGitBranches,
  type GitBranch,
  type GitBranchList,
  type GitSummary,
} from '@/lib/git-api';

interface GitBranchPickerProps {
  projectId: string;
  /** Called once the workspace git probe settles (success only). */
  onGitAvailabilityChange?: (isGit: boolean) => void;
}

function toMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Workspace branch switcher for the welcome page. Reads the real repository
 * HEAD via the gateway — never session metadata — and lets the user search,
 * check out, or create branches before starting a conversation.
 */
export function GitBranchPicker({
  projectId,
  onGitAvailabilityChange,
}: GitBranchPickerProps) {
  const [summary, setSummary] = useState<GitSummary | null>(null);
  const [loading, setLoading] = useState(true);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [list, setList] = useState<GitBranchList | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [mutating, setMutating] = useState(false);

  // Keep the latest callback without putting it in the effect deps — a
  // parent re-render with a new function identity must not re-fetch.
  const availabilityRef = useRef(onGitAvailabilityChange);
  availabilityRef.current = onGitAvailabilityChange;

  // Probe summary on mount and whenever the selected workspace changes.
  // The cancelled flag ignores stale responses so a slow previous project
  // can never overwrite the current one's branch label.
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setSummary(null);
    setQuery('');
    setList(null);
    setError(null);
    setMutating(false);
    setOpen(false);

    fetchGitSummary(projectId)
      .then((next) => {
        if (cancelled) return;
        setSummary(next);
        setLoading(false);
        availabilityRef.current?.(next.isGit);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setError(toMessage(err));
        setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [projectId]);

  // Search branches while the popover is open; empty query lists everything
  // (server-side truncated). Cancelled on close / query / project change.
  useEffect(() => {
    if (!open || !summary?.isGit) return;
    let cancelled = false;
    searchGitBranches(projectId, query)
      .then((next) => {
        if (cancelled) return;
        setList(next);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setError(toMessage(err));
      });
    return () => {
      cancelled = true;
    };
  }, [open, query, projectId, summary?.isGit]);

  const refreshList = useCallback(
    async (q: string) => {
      const next = await searchGitBranches(projectId, q);
      setList(next);
    },
    [projectId],
  );

  const runCheckout = useCallback(
    async (branch: GitBranch) => {
      if (mutating) return;
      setMutating(true);
      setError(null);
      try {
        const next = await checkoutGitBranch({
          projectId,
          name: branch.name,
          kind: branch.kind,
        });
        // Only a successful mutation moves the label; a failure keeps the
        // previous summary untouched and just surfaces the error.
        setSummary(next);
        await refreshList(query);
        setOpen(false);
      } catch (err: unknown) {
        setError(toMessage(err));
      } finally {
        setMutating(false);
      }
    },
    [mutating, projectId, query, refreshList],
  );

  const runCreate = useCallback(async () => {
    const name = query.trim();
    if (!name || mutating) return;
    setMutating(true);
    setError(null);
    try {
      const next = await createGitBranch({ projectId, name });
      setSummary(next);
      setQuery('');
      await refreshList('');
      setOpen(false);
    } catch (err: unknown) {
      setError(toMessage(err));
    } finally {
      setMutating(false);
    }
  }, [mutating, projectId, query, refreshList]);

  if (loading) {
    return <Skeleton className="h-7 w-24" data-testid="git-branch-picker-skeleton" />;
  }
  if (!summary?.isGit) return null;

  const localBranches = list?.branches.filter((b) => b.kind === 'local') ?? [];
  const remoteBranches = list?.branches.filter((b) => b.kind === 'remote') ?? [];
  const canCreate = query.trim().length > 0;

  return (
    <div data-testid="git-branch-picker">
      <Popover
        open={open}
        onOpenChange={(next) => {
          setOpen(next);
          if (!next) {
            setQuery('');
            setError(null);
          }
        }}
      >
        <PopoverTrigger
          className="hover:bg-muted flex h-7 max-w-56 items-center gap-1.5 rounded-[min(var(--radius-md),10px)] px-2.5 text-sm whitespace-nowrap transition-colors outline-none select-none"
          aria-label="当前分支"
          disabled={mutating}
        >
          <GitBranchIcon className="text-primary/80 h-3.5 w-3.5 shrink-0" />
          <span className="truncate font-mono">{summary.branch ?? 'HEAD'}</span>
          <ChevronDown className="text-muted-foreground h-4 w-4 shrink-0" />
        </PopoverTrigger>

        <PopoverContent className="w-72 p-2">
          <Input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="搜索分支"
            aria-label="搜索分支"
            className="h-8"
          />

          {error && (
            <div
              role="alert"
              className="text-destructive bg-destructive/5 border-destructive/30 mt-2 rounded-md border px-2 py-1.5 text-xs"
            >
              {error}
            </div>
          )}

          <div className="mt-2 max-h-64 overflow-y-auto">
            {localBranches.length > 0 && (
              <div>
                <div className="text-muted-foreground px-1 py-1 text-xs">
                  本地分支
                </div>
                {localBranches.map((branch) => (
                  <BranchRow
                    key={`local:${branch.name}`}
                    branch={branch}
                    current={branch.name === summary.branch}
                    disabled={mutating}
                    onClick={() => void runCheckout(branch)}
                  />
                ))}
              </div>
            )}
            {remoteBranches.length > 0 && (
              <div>
                <div className="text-muted-foreground px-1 py-1 text-xs">
                  远端分支
                </div>
                {remoteBranches.map((branch) => (
                  <BranchRow
                    key={`remote:${branch.name}`}
                    branch={branch}
                    current={false}
                    disabled={mutating}
                    onClick={() => void runCheckout(branch)}
                  />
                ))}
              </div>
            )}
            {list !== null &&
              localBranches.length === 0 &&
              remoteBranches.length === 0 && (
                <div className="text-muted-foreground px-1 py-2 text-xs">
                  没有匹配的分支
                </div>
              )}
            {list?.truncated && (
              <div className="text-muted-foreground px-1 py-1 text-xs">
                结果已截断，请细化搜索
              </div>
            )}
          </div>

          {canCreate && (
            <Button
              variant="ghost"
              size="sm"
              className="mt-1 w-full justify-start gap-1.5"
              disabled={mutating}
              onClick={() => void runCreate()}
            >
              <Plus className="h-3.5 w-3.5" />
              <span className="truncate font-mono">
                创建分支 “{query.trim()}”
              </span>
            </Button>
          )}
        </PopoverContent>
      </Popover>
    </div>
  );
}

function BranchRow({
  branch,
  current,
  disabled,
  onClick,
}: {
  branch: GitBranch;
  current: boolean;
  disabled: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      className={cn(
        'hover:bg-accent flex w-full items-center gap-2 rounded-md px-1.5 py-1.5 text-left text-sm disabled:pointer-events-none disabled:opacity-50',
        current && 'bg-accent/50',
      )}
    >
      <span className="flex-1 truncate font-mono text-xs">{branch.name}</span>
      {current && (
        <span className="text-muted-foreground shrink-0 text-[10px]">
          当前
        </span>
      )}
    </button>
  );
}
