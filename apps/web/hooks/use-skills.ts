'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { fetchSkillEntries, type SkillEntry } from '@/lib/agent-config';

export type SkillsStatus = 'loading' | 'ready' | 'error';

export interface UseSkillsResult {
  skills: SkillEntry[];
  status: SkillsStatus;
  /** Re-fetches the catalog; resolves once the reload settles. */
  refresh: () => Promise<void>;
}

/**
 * Loads every on-disk skill definition (user-level and project-level,
 * including shadowed losers) for the settings catalog.
 *
 * `projectId` scopes the project-level source on the gateway; null means the
 * server's default cwd. A failed load surfaces as `status: 'error'` rather
 * than a silent empty list, so the panel can tell "there are no skills" apart
 * from "the gateway is down".
 */
export function useSkills(projectId: string | null): UseSkillsResult {
  const [skills, setSkills] = useState<SkillEntry[]>([]);
  const [status, setStatus] = useState<SkillsStatus>('loading');

  // Monotonic load id: a load that settles after a newer one started must not
  // clobber the newer result (stale-response guard).
  const loadIdRef = useRef(0);

  const load = useCallback(async () => {
    const loadId = ++loadIdRef.current;
    try {
      const entries = await fetchSkillEntries(projectId);
      if (loadId !== loadIdRef.current) return;
      setSkills(entries);
      setStatus('ready');
    } catch {
      if (loadId !== loadIdRef.current) return;
      setStatus('error');
    }
  }, [projectId]);

  useEffect(() => {
    void (async () => {
      await load();
    })();
  }, [load]);

  const refresh = useCallback(() => load(), [load]);

  return { skills, status, refresh };
}
