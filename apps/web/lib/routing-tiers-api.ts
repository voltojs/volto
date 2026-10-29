/**
 * Client for the gateway's model routing tier table
 * (`GET|PUT /config/routing-tiers`) — the mapping from a symbolic tier id
 * (what agent definitions reference) to the concrete model a sub-agent
 * dispatch resolves to.
 *
 * `PUT` replaces the whole table with a bare `RoutingTier[]` array (no
 * wrapper object). A removed tier id that agent definitions still
 * reference answers 409; the referencing definitions travel on the thrown
 * `ApiError`'s `body` as a `RoutingTierConflict`.
 */

import { SERVER_URL } from './agent-config';
import { ApiError } from './config-api';

export interface RoutingTier {
  id: string;
  label: string;
  description: string;
  target: { providerId: string; modelId: string };
}

/** One agent definition whose `model:` references a tier being removed. */
export interface TierReference {
  name: string;
  scope: 'project' | 'user' | 'plugin';
}

/** A registered project the server's reference scan could not read. */
export interface TierScanSkip {
  projectPath: string;
  reason: string;
}

/** The 409 body of `PUT /config/routing-tiers`. */
export interface RoutingTierConflict {
  error: string;
  references: TierReference[];
  skipped?: TierScanSkip[];
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${SERVER_URL}${path}`, {
    // Cookie auth (Route P): the gateway rejects unauthenticated calls.
    credentials: 'include',
    ...init,
    headers: init?.body ? { 'Content-Type': 'application/json' } : undefined,
  });

  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as
      | { error?: string }
      | null;
    throw new ApiError(
      body?.error ?? `Request failed with HTTP ${response.status}`,
      response.status,
      body,
    );
  }
  return (await response.json()) as T;
}

/** The current table; an empty array means "no tiers configured yet". */
export async function fetchRoutingTiers(): Promise<RoutingTier[]> {
  const body = await request<{ tiers: RoutingTier[] }>('/config/routing-tiers');
  return body.tiers;
}

/**
 * Replace the whole table. Rejects with `ApiError`: 400 names the offending
 * tier in `message`, 409 carries a `RoutingTierConflict` in `body`.
 */
export function saveRoutingTiers(tiers: RoutingTier[]): Promise<void> {
  return request<void>('/config/routing-tiers', {
    method: 'PUT',
    body: JSON.stringify(tiers),
  });
}
