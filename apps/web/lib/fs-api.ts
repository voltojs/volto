/**
 * Client for the gateway's read-only file-browsing endpoints
 * (`GET /fs/tree`, `GET /fs/search`, `GET /fs/file`). Paths are
 * project-relative; the server enforces root confinement, this layer just
 * encodes and surfaces errors — same readErrorMessage convention as
 * sessions-api.ts.
 */

import { gatewayUrl } from './gateway-base';

export interface FsEntry {
  name: string;
  type: 'dir' | 'file';
  size: number;
}
export interface FsTreeResult {
  path: string;
  entries: FsEntry[];
}
export interface FsSearchMatch {
  path: string;
  type: 'dir' | 'file';
}
export interface FsSearchResult {
  matches: FsSearchMatch[];
}
export type FsFilePayload =
  | { kind: 'text'; content: string; truncated: boolean; size: number }
  | { kind: 'image'; base64: string; mediaType: string; size: number }
  | { kind: 'binary'; size: number };

async function readErrorMessage(response: Response, fallback: string): Promise<string> {
  try {
    const body = (await response.json()) as { error?: unknown };
    return typeof body.error === 'string' && body.error.length > 0 ? body.error : fallback;
  } catch {
    return fallback;
  }
}

async function getJson<T>(requestPath: string): Promise<T> {
  const response = await fetch(gatewayUrl(requestPath), { credentials: 'include' });
  if (!response.ok) {
    throw new Error(await readErrorMessage(response, `Request failed: HTTP ${response.status}`));
  }
  return (await response.json()) as T;
}

export function fetchFsTree(projectId: string, path = ''): Promise<FsTreeResult> {
  return getJson(`/fs/tree?projectId=${encodeURIComponent(projectId)}&path=${encodeURIComponent(path)}`);
}

export function searchFsFiles(projectId: string, q: string): Promise<FsSearchResult> {
  return getJson(`/fs/search?projectId=${encodeURIComponent(projectId)}&q=${encodeURIComponent(q)}`);
}

export function fetchFsFile(projectId: string, path: string): Promise<FsFilePayload> {
  return getJson(`/fs/file?projectId=${encodeURIComponent(projectId)}&path=${encodeURIComponent(path)}`);
}
