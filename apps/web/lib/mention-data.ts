/**
 * @-mention query routing. The text typed after "@" IS the path being typed:
 * empty or trailing-slash queries list a directory, a slash in the middle
 * filters that directory's listing by basename prefix, anything else is a
 * global filename search. Pure functions only — fetch lives in the hook.
 */
import type { FsEntry } from './fs-api';

export interface MentionEntry {
  name: string;
  path: string;
  type: 'dir' | 'file';
}

export type MentionQuery =
  | { mode: 'list'; dir: string }
  | { mode: 'filter'; dir: string; basename: string }
  | { mode: 'search'; term: string };

export function resolveMentionQuery(query: string): MentionQuery {
  if (query === '' || query.endsWith('/')) return { mode: 'list', dir: query };
  const slash = query.lastIndexOf('/');
  if (slash === -1) return { mode: 'search', term: query };
  return { mode: 'filter', dir: query.slice(0, slash + 1), basename: query.slice(slash + 1) };
}

export function toMentionEntries(dir: string, entries: FsEntry[]): MentionEntry[] {
  return entries.map((e) => ({ name: e.name, path: `${dir}${e.name}`, type: e.type }));
}

export function searchMatchesToEntries(matches: string[]): MentionEntry[] {
  return matches.map((p) => ({ name: p, path: p, type: 'file' as const }));
}

export function filterEntries(entries: MentionEntry[], basename: string): MentionEntry[] {
  const prefix = basename.toLowerCase();
  return entries.filter((e) => e.name.toLowerCase().startsWith(prefix));
}

export function drillPath(entry: MentionEntry): string | undefined {
  return entry.type === 'dir' ? `${entry.path}/` : undefined;
}
