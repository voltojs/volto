/**
 * Client for the gateway's workspace Git endpoints
 * (`GET /git/summary|branches|graph|commits/:hash`,
 * `POST /git/checkout|branches`). Same gateway URL, credentials, and
 * readErrorMessage convention as fs-api.ts; response types are Git's own
 * and stay independent of the fs client.
 */

import { gatewayUrl } from './gateway-base';

export interface GitSummary {
  isGit: boolean;
  branch: string | null;
  head: string | null;
}

export interface GitBranch {
  name: string;
  kind: 'local' | 'remote';
  remote?: string;
  upstream?: string;
}

export interface GitBranchList {
  branches: GitBranch[];
  truncated: boolean;
}

export interface GitGraphNode {
  hash: string;
  parents: string[];
  subject: string;
  author: string;
  authoredAt: string;
  refs: string[];
}

export interface GitGraph {
  nodes: GitGraphNode[];
  truncated: boolean;
}

export interface GitFileChange {
  status: string;
  path: string;
}

export interface GitCommitDetail {
  hash: string;
  parents: string[];
  subject: string;
  body: string;
  author: string;
  authoredAt: string;
  files: GitFileChange[];
}

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

async function postJson<T>(requestPath: string, body: unknown): Promise<T> {
  const response = await fetch(gatewayUrl(requestPath), {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    throw new Error(await readErrorMessage(response, `Request failed: HTTP ${response.status}`));
  }
  return (await response.json()) as T;
}

export function fetchGitSummary(projectId: string): Promise<GitSummary> {
  return getJson(`/git/summary?projectId=${encodeURIComponent(projectId)}`);
}

export function searchGitBranches(projectId: string, q: string): Promise<GitBranchList> {
  return getJson(
    `/git/branches?projectId=${encodeURIComponent(projectId)}&q=${encodeURIComponent(q)}`,
  );
}

export const checkoutGitBranch = (input: {
  projectId: string;
  name: string;
  kind: GitBranch['kind'];
}): Promise<GitSummary> => postJson<GitSummary>('/git/checkout', input);

export const createGitBranch = (input: {
  projectId: string;
  name: string;
}): Promise<GitSummary> => postJson<GitSummary>('/git/branches', input);

export function fetchGitGraph(projectId: string, limit?: number): Promise<GitGraph> {
  const params = new URLSearchParams({ projectId });
  if (limit !== undefined) params.set('limit', String(limit));
  return getJson(`/git/graph?${params.toString()}`);
}

export function fetchGitCommit(projectId: string, hash: string): Promise<GitCommitDetail> {
  return getJson(
    `/git/commits/${encodeURIComponent(hash)}?projectId=${encodeURIComponent(projectId)}`,
  );
}
