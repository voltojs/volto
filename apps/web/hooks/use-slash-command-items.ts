'use client';

import { useCallback, useEffect, useState } from 'react';
import {
  fetchCommands,
  fetchSkills,
  type CommandDescriptor,
  type SkillDescriptor,
} from '@/lib/agent-config';
import { ACTION_COMMANDS, type CommandItem } from '@/lib/input-commands';

const GLOBAL_KEY = '__global__';
const cache = new Map<string, CommandItem[]>();

export function clearSlashCommandCache(): void {
  cache.clear();
}

function mergeItems(commands: CommandDescriptor[], skills: SkillDescriptor[]): CommandItem[] {
  // 顺序 verbatim：action/template 相邻在前，skills 殿后——分组渲染靠 kind 切换插组头。
  return [
    ...ACTION_COMMANDS,
    ...commands.map((c) => ({
      kind: 'template' as const,
      name: c.name,
      description: c.description,
      hasArgs: c.args != null,
    })),
    ...skills
      .filter((s) => s.userInvocable)
      .map((s) => ({ kind: 'skill' as const, name: s.name, description: s.description })),
  ];
}

export function useSlashCommandItems(projectId: string | null) {
  const key = projectId ?? GLOBAL_KEY;
  const [items, setItems] = useState<CommandItem[]>(() => cache.get(key) ?? []);
  const [isLoading, setIsLoading] = useState<boolean>(() => !cache.has(key));
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    const cached = cache.get(key);
    if (cached) {
      // Bootstrap from the external module cache (mounted with a warm key, or
      // re-keyed onto one): one synchronous sync, then the effect is done.
      // The set-state-in-effect rule flags this shape, but the alternative
      // (useSyncExternalStore or render-phase adjust) would rewrite the
      // planned contract for a once-per-mount render.
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setItems(cached);
      setIsLoading(false);
      setError(null);
      return;
    }
    let cancelled = false;
    setIsLoading(true);
    setError(null);
    void (async () => {
      try {
        const [commands, skills] = await Promise.all([fetchCommands(), fetchSkills(projectId)]);
        const merged = mergeItems(commands, skills);
        cache.set(key, merged);
        if (cancelled) return;
        setItems(merged);
        setIsLoading(false);
      } catch (err) {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : '加载命令失败');
        setIsLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [key, projectId, attempt]);

  const retry = useCallback(() => {
    cache.delete(key);
    setAttempt((n) => n + 1);
  }, [key]);

  return { items, isLoading, error, retry };
}
