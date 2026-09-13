// apps/web/hooks/use-file-mention-items.ts
'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { fetchFsTree, searchFsFiles, type FsEntry } from '@/lib/fs-api';
import {
  filterEntries,
  resolveMentionQuery,
  searchMatchesToEntries,
  toMentionEntries,
  type MentionEntry,
} from '@/lib/mention-data';

/** Directory listings cached per `${projectId}:${dir}` — typing "src/c",
 *  "src/co" ... re-uses one fetch per directory. Searches are not cached. */
const dirCache = new Map<string, FsEntry[]>();

export function clearFileMentionCache(): void {
  dirCache.clear();
}

const SEARCH_DEBOUNCE_MS = 300;

export function useFileMentionItems(projectId: string | null, query: string) {
  const [entries, setEntries] = useState<MentionEntry[]>([]);
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading');
  const [attempt, setAttempt] = useState(0);
  const mentionQuery = useMemo(() => resolveMentionQuery(query), [query]);

  useEffect(() => {
    if (!projectId) {
      // 无项目即 ready 空列表：props 引发的同步 bootstrap，每次挂载/换键至多一次。
      // set-state-in-effect 规则报 error（门禁硬失败），但替代方案（useSyncExternalStore
      // 或 render 期调整）会重写 brief 契约且同样被规则限制——按行 disable。
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setEntries([]);
      setStatus('ready');
      return;
    }
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;

    async function load(): Promise<void> {
      if (mentionQuery.mode === 'search') {
        const { matches } = await searchFsFiles(projectId!, mentionQuery.term);
        if (cancelled) return;
        setEntries(searchMatchesToEntries(matches));
        setStatus('ready');
        return;
      }
      const cacheKey = `${projectId}:${mentionQuery.dir}`;
      let listing = dirCache.get(cacheKey);
      if (!listing) {
        const tree = await fetchFsTree(projectId!, mentionQuery.dir);
        listing = tree.entries;
        dirCache.set(cacheKey, listing);
      }
      if (cancelled) return;
      const mapped = toMentionEntries(mentionQuery.dir, listing);
      setEntries(mentionQuery.mode === 'filter' ? filterEntries(mapped, mentionQuery.basename) : mapped);
      setStatus('ready');
    }

    void (async () => {
      try {
        setStatus('loading');
        if (mentionQuery.mode === 'search') {
          timer = setTimeout(() => void load(), SEARCH_DEBOUNCE_MS);
        } else {
          await load();
        }
      } catch {
        if (!cancelled) setStatus('error');
      }
    })();

    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [projectId, mentionQuery, attempt]);

  const retry = useCallback(() => setAttempt((n) => n + 1), []);

  return { entries, status, retry };
}
