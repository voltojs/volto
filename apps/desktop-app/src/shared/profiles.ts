/**
 * Pure profile rules, shared by the main process (the authority) and the
 * renderer (instant form feedback).
 */

import {
  DEFAULT_PROFILE_LABEL,
  type GatewayKind,
  type GatewayProfile,
  type GatewayStatus,
  type ProfileDraft,
  type PublicGatewayProfile,
  type ShellPlatform,
  type ShellState,
} from "./gateway";

export const DEFAULT_PROFILE_ID = "local";

export interface NormalizedDraft {
  label: string;
  kind: GatewayKind;
  url: string;
  managed: boolean;
  token?: string;
}

export interface PersistedProfiles {
  profiles: GatewayProfile[];
  activeProfileId: string;
}

const MAX_LABEL_LENGTH = 60;

function failure(error: string): { ok: false; error: string } {
  return { ok: false, error };
}

/** The single profile a fresh install starts with. */
export function defaultPersistedProfiles(): PersistedProfiles {
  return {
    profiles: [
      {
        id: DEFAULT_PROFILE_ID,
        label: DEFAULT_PROFILE_LABEL,
        kind: "local",
        url: "",
        managed: true,
      },
    ],
    activeProfileId: DEFAULT_PROFILE_ID,
  };
}

/**
 * Accepts `host:port`, `http://host`, `https://host/` and returns the origin.
 * Rejects anything a browser would treat as more than an origin: a path, a
 * query, a fragment or embedded credentials.
 */
export function normalizeGatewayUrl(raw: string): { ok: true; url: string } | { ok: false; error: string } {
  const trimmed = raw.trim();
  if (trimmed === "") return failure("网关地址不能为空");
  const hasScheme = /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(trimmed);
  let parsed: URL;
  try {
    parsed = new URL(hasScheme ? trimmed : `http://${trimmed}`);
  } catch {
    return failure("网关地址无效");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return failure("网关地址只支持 http:// 或 https://");
  }
  if (parsed.username !== "" || parsed.password !== "") {
    return failure("网关地址不能包含用户名或密码");
  }
  if (parsed.search !== "" || parsed.hash !== "") {
    return failure("网关地址不能带查询参数或锚点");
  }
  if (parsed.pathname !== "/" && parsed.pathname !== "") {
    return failure("网关地址只填到端口，不要带路径");
  }
  return { ok: true, url: parsed.origin };
}

/** Validate and normalize one profile draft; the only place these rules live. */
export function normalizeProfileDraft(
  draft: ProfileDraft,
): { ok: true; value: NormalizedDraft } | { ok: false; error: string } {
  const label = draft.label.trim();
  if (label === "") return failure("名称不能为空");
  if (label.length > MAX_LABEL_LENGTH) return failure(`名称不能超过 ${MAX_LABEL_LENGTH} 个字符`);
  const token = draft.token?.trim();
  const tokenField = token !== undefined && token !== "" ? { token } : {};

  if (draft.kind === "remote") {
    const url = normalizeGatewayUrl(draft.url ?? "");
    if (!url.ok) return url;
    return {
      ok: true,
      value: { label, kind: "remote", url: url.url, managed: false, ...tokenField },
    };
  }

  let url = "";
  if ((draft.url ?? "").trim() !== "") {
    const normalized = normalizeGatewayUrl(draft.url ?? "");
    if (!normalized.ok) return normalized;
    url = normalized.url;
  }
  const managed = draft.managed !== false;
  if (!managed && url === "") return failure("直连本机网关需要填写地址");
  return { ok: true, value: { label, kind: "local", url, managed, ...tokenField } };
}

/** Replace by id, or append when the id is new. Returns a new array. */
export function upsertProfile(
  profiles: readonly GatewayProfile[],
  profile: GatewayProfile,
): GatewayProfile[] {
  const index = profiles.findIndex((entry) => entry.id === profile.id);
  if (index < 0) return [...profiles, profile];
  const next = [...profiles];
  next[index] = profile;
  return next;
}

/** Remove a profile, refusing to leave the app without one. */
export function removeProfile(
  profiles: readonly GatewayProfile[],
  id: string,
  activeProfileId: string,
): { ok: true; profiles: GatewayProfile[]; activeProfileId: string } | { ok: false; error: string } {
  if (!profiles.some((entry) => entry.id === id)) return failure("网关不存在");
  if (profiles.length <= 1) return failure("至少保留一个网关");
  const next = profiles.filter((entry) => entry.id !== id);
  const nextActiveId =
    activeProfileId === id ? (next[0]?.id ?? DEFAULT_PROFILE_ID) : activeProfileId;
  return { ok: true, profiles: next, activeProfileId: nextActiveId };
}

function isProfile(value: unknown): value is GatewayProfile {
  if (typeof value !== "object" || value === null) return false;
  const entry = value as Record<string, unknown>;
  if (typeof entry["id"] !== "string" || entry["id"].trim() === "") return false;
  if (typeof entry["label"] !== "string" || entry["label"].trim() === "") return false;
  if (entry["kind"] !== "local" && entry["kind"] !== "remote") return false;
  if (typeof entry["url"] !== "string") return false;
  if (typeof entry["managed"] !== "boolean") return false;
  if (entry["kind"] === "remote" && entry["url"] === "") return false;
  if (entry["kind"] === "local" && entry["managed"] === false && entry["url"] === "") return false;
  if (entry["token"] !== undefined && typeof entry["token"] !== "string") return false;
  return true;
}

/**
 * Recover usable profiles from whatever is on disk. A corrupt store must not
 * brick the app: invalid entries are dropped, and an empty result falls back
 * to the default profile.
 */
export function sanitizePersistedProfiles(raw: unknown, fallback: PersistedProfiles): PersistedProfiles {
  if (typeof raw !== "object" || raw === null) return fallback;
  const record = raw as Record<string, unknown>;
  const entries = Array.isArray(record["profiles"]) ? record["profiles"] : [];
  const seen = new Set<string>();
  const profiles: GatewayProfile[] = [];
  for (const candidate of entries) {
    if (!isProfile(candidate)) continue;
    if (seen.has(candidate.id)) continue;
    seen.add(candidate.id);
    const token = candidate.token?.trim();
    profiles.push({
      id: candidate.id,
      label: candidate.label.trim(),
      kind: candidate.kind,
      url: candidate.url,
      managed: candidate.kind === "remote" ? false : candidate.managed,
      ...(token !== undefined && token !== "" ? { token } : {}),
    });
  }
  if (profiles.length === 0) return fallback;
  const requestedActive = typeof record["activeProfileId"] === "string" ? record["activeProfileId"] : "";
  const activeProfileId = profiles.some((entry) => entry.id === requestedActive)
    ? requestedActive
    : (profiles[0]?.id ?? fallback.activeProfileId);
  return { profiles, activeProfileId };
}

/** Strip tokens from anything crossing into the renderer. */
export function toPublicState(input: {
  profiles: GatewayProfile[];
  activeProfileId: string;
  status: GatewayStatus;
  sheetOpen: boolean;
  platform: ShellPlatform;
  appVersion: string;
}): ShellState {
  const profiles: PublicGatewayProfile[] = input.profiles.map(({ token, ...rest }) => ({
    ...rest,
    hasToken: token !== undefined && token !== "",
  }));
  return {
    profiles,
    activeProfileId: input.activeProfileId,
    status: input.status,
    sheetOpen: input.sheetOpen,
    platform: input.platform,
    appVersion: input.appVersion,
  };
}