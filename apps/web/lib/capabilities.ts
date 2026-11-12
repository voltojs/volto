/**
 * What the gateway said it can do, fetched once at boot.
 *
 * `GET /gateway-info` publishes the instance's posture (`mode`) and its
 * capability facts. The client needs one of them for a real decision: whether
 * `/fs/pick-directory` will actually open a dialog. In remote mode the gateway
 * withdraws that capability (`capabilities.nativeDialogs === false`, every
 * method answers `501 capability_unavailable`), so offering the native picker
 * there produces a 501 nobody can act on — the flow has to ask for a typed
 * path instead.
 *
 * The fetch is guarded, never fatal: a gateway that predates the field, a 401
 * during a re-login, or a network blip all resolve to UNKNOWN, and every
 * caller treats unknown as "try the documented path" rather than as "this
 * capability is gone".
 */

import { create } from 'zustand';
import { gatewayUrl } from './gateway-base';

/** The capability flags this client reads. Absent fields mean UNKNOWN. */
export interface GatewayCapabilities {
  /** `false` only when the gateway stated that native dialogs are withdrawn. */
  nativeDialogs?: boolean;
}

export type CapabilitiesStatus = 'unknown' | 'ready';

interface CapabilitiesState {
  status: CapabilitiesStatus;
  capabilities: GatewayCapabilities;
}

export const useCapabilitiesStore = create<CapabilitiesState>(() => ({
  status: 'unknown',
  capabilities: {},
}));

/** `GET /gateway-info`'s shape, as far as this client reads it. */
interface GatewayInfo {
  mode?: unknown;
  capabilities?: { nativeDialogs?: unknown };
}

/**
 * Read capabilities from an already-fetched `/gateway-info` body. Pure, so the
 * "what counts as a stated `false`" rule is testable without a server.
 */
export function readCapabilities(body: unknown): GatewayCapabilities {
  if (typeof body !== 'object' || body === null) return {};
  const { capabilities } = body as GatewayInfo;
  if (typeof capabilities !== 'object' || capabilities === null) return {};
  // Only an explicit boolean is a fact; anything else stays unknown.
  return typeof capabilities.nativeDialogs === 'boolean'
    ? { nativeDialogs: capabilities.nativeDialogs }
    : {};
}

/**
 * `true` only when the gateway said so. Everything else — not fetched yet,
 * unreachable, a gateway too old to publish the field — is `false`, because
 * the safe assumption is that the native dialog is worth trying until the
 * gateway says otherwise.
 */
export function nativeDialogsWithdrawn(
  capabilities: GatewayCapabilities,
): boolean {
  return capabilities.nativeDialogs === false;
}

/**
 * Fetch `/gateway-info` once and publish what it says.
 *
 * Safe to call more than once (a second boot in the same page, a retry): a
 * settled fetch is not repeated, so this is one request per page load. Errors
 * are swallowed into UNKNOWN — a capability lookup must never break boot.
 */
export async function loadCapabilities(): Promise<void> {
  if (useCapabilitiesStore.getState().status === 'ready') return;
  try {
    const response = await fetch(gatewayUrl('/gateway-info'), {
      credentials: 'include',
      headers: { Accept: 'application/json' },
    });
    if (!response.ok) return;
    const body: unknown = await response.json().catch(() => null);
    useCapabilitiesStore.setState({
      status: 'ready',
      capabilities: readCapabilities(body),
    });
  } catch {
    // Keep UNKNOWN: the UI falls back to what it did before this contract.
  }
}

/** Test seam: back to UNKNOWN so the next `loadCapabilities` fetches again. */
export function resetCapabilitiesForTest(): void {
  useCapabilitiesStore.setState({ status: 'unknown', capabilities: {} });
}

/**
 * The client-side reading of `501 capability_unavailable`.
 *
 * `ApiError.message` carries the raw error CODE the gateway put in the body
 * (`capability_unavailable`), which is useless on screen. This maps it to a
 * sentence the user can act on. `message` is passed loose so callers do not
 * have to import the error class just to classify it.
 */
export function capabilityUnavailableMessage(
  error: unknown,
  copy: { picker: string; reveal: string },
): string | undefined {
  const shaped = error as
    { status?: unknown; message?: unknown } | null | undefined;
  if (typeof shaped !== 'object' || shaped === null) return undefined;
  // `501` is the status the gateway uses for a withdrawn capability; the code
  // in the body is what it answers with today. Either one is enough — a proxy
  // or an older build may deliver only one of them.
  if (shaped.status !== 501 && shaped.message !== 'capability_unavailable')
    return undefined;
  const message = typeof shaped.message === 'string' ? shaped.message : '';
  return message.toLowerCase().includes('reveal') ? copy.reveal : copy.picker;
}
