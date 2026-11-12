/**
 * Client for the gateway's settle-time file reference annotations
 * (`GET /file-refs`). Annotations are session memory: the server recomputes
 * them from the durable log on demand — nothing is persisted anywhere.
 */

import { gatewayUrl } from './gateway-base';
import type { RowRefSet } from '@volto/sdk/file-refs';

async function readErrorMessage(response: Response, fallback: string): Promise<string> {
  try {
    const body = (await response.json()) as { error?: unknown };
    return typeof body.error === 'string' && body.error.length > 0 ? body.error : fallback;
  } catch {
    return fallback;
  }
}

export function fetchFileRefs(projectId: string, sessionId: string): Promise<RowRefSet[]> {
  return fetch(
    gatewayUrl(
      `/file-refs?projectId=${encodeURIComponent(projectId)}&sessionId=${encodeURIComponent(sessionId)}`,
    ),
    { credentials: 'include' },
  ).then(async (response) => {
    if (!response.ok) {
      throw new Error(await readErrorMessage(response, `Request failed: HTTP ${response.status}`));
    }
    return ((await response.json()) as { refs: RowRefSet[] }).refs;
  });
}
