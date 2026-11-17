/**
 * The gateway selection state machine: which profile is active, how it is
 * started, and whether it is reachable.
 *
 * Deliberately free of electron imports so the whole switch flow is testable
 * on plain Node. Every async step is guarded by a generation counter: a slow
 * probe for the profile the user just left must not overwrite the profile
 * they switched to.
 */

import { randomUUID } from "node:crypto";

import {
  buildGatewayEntryUrl,
  type ActionResult,
  type GatewayProfile,
  type GatewayStatus,
  type ProfileDraft,
  type ShellPlatform,
  type ShellState,
} from "@shared/gateway";
import {
  defaultPersistedProfiles,
  normalizeProfileDraft,
  removeProfile as removeProfileRule,
  sanitizePersistedProfiles,
  toPublicState,
  upsertProfile,
  type PersistedProfiles,
} from "@shared/profiles";

import type { ProbeResult } from "./probe";
import type { RunningGateway } from "./supervisor";

export interface ProfileStoreLike {
  load(): Promise<PersistedProfiles>;
  save(value: PersistedProfiles): Promise<void>;
}

export type ControllerEvent =
  | { type: "status"; status: GatewayStatus }
  | { type: "navigate"; url: string; profileId: string };

export interface GatewayControllerDeps {
  store: ProfileStoreLike;
  supervisor: {
    start(profile: GatewayProfile): Promise<RunningGateway>;
    stop(): Promise<void>;
  };
  probe: (url: string, token?: string) => Promise<ProbeResult>;
  platform?: ShellPlatform;
  appVersion?: string;
  idFactory?: () => string;
  onEvent?: (event: ControllerEvent) => void;
}

function messageOf(error: unknown): string {
  return error instanceof Error && error.message !== "" ? error.message : String(error);
}

function platformOf(): ShellPlatform {
  if (process.platform === "darwin") return "darwin";
  if (process.platform === "win32") return "win32";
  return "linux";
}

export class GatewayController {
  private readonly deps: GatewayControllerDeps;
  private readonly platform: ShellPlatform;
  private readonly appVersion: string;
  private readonly idFactory: () => string;
  private readonly listeners = new Set<(event: ControllerEvent) => void>();

  private persisted: PersistedProfiles = defaultPersistedProfiles();
  private status: GatewayStatus = {
    state: "idle",
    profileId: defaultPersistedProfiles().activeProfileId,
  };
  private sheetOpen = false;
  private generation = 0;
  private disposed = false;
  private lastEntryUrlValue: string | undefined;

  constructor(deps: GatewayControllerDeps) {
    this.deps = deps;
    this.platform = deps.platform ?? platformOf();
    this.appVersion = deps.appVersion ?? "0.0.0";
    this.idFactory = deps.idFactory ?? randomUUID;
  }

  subscribe(listener: (event: ControllerEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  getState(): ShellState {
    return toPublicState({
      profiles: this.persisted.profiles,
      activeProfileId: this.persisted.activeProfileId,
      status: this.status,
      sheetOpen: this.sheetOpen,
      platform: this.platform,
      appVersion: this.appVersion,
    });
  }

  async init(): Promise<void> {
    let loaded: PersistedProfiles;
    try {
      loaded = sanitizePersistedProfiles(await this.deps.store.load(), defaultPersistedProfiles());
    } catch {
      loaded = defaultPersistedProfiles();
    }
    this.persisted = loaded;
    this.status = { state: "idle", profileId: loaded.activeProfileId };
    this.emitStatus();
    await this.connect(loaded.activeProfileId);
  }

  setSheetOpen(open: boolean): void {
    if (this.sheetOpen === open) return;
    this.sheetOpen = open;
    this.emitStatus();
  }

  async saveProfile(draft: ProfileDraft): Promise<ActionResult> {
    const normalized = normalizeProfileDraft(draft);
    if (!normalized.ok) return { ok: false, error: normalized.error };

    const existing =
      draft.id === undefined
        ? undefined
        : this.persisted.profiles.find((profile) => profile.id === draft.id);
    if (draft.id !== undefined && existing === undefined) {
      return { ok: false, error: "网关不存在" };
    }

    // An empty token input means "keep the stored one"; switching to a local
    // profile drops it, because a local gateway supplies its own token.
    const token =
      normalized.value.token ??
      (normalized.value.kind === "remote" ? existing?.token : undefined);
    const profile: GatewayProfile = {
      id: draft.id ?? this.idFactory(),
      label: normalized.value.label,
      kind: normalized.value.kind,
      url: normalized.value.url,
      managed: normalized.value.managed,
      ...(token !== undefined && token !== "" ? { token } : {}),
    };

    this.persisted = {
      profiles: upsertProfile(this.persisted.profiles, profile),
      activeProfileId: this.persisted.activeProfileId,
    };
    await this.persist();

    if (this.persisted.activeProfileId === profile.id) {
      await this.connect(profile.id);
    } else {
      this.emitStatus();
    }
    return { ok: true, state: this.getState() };
  }

  async removeProfile(id: string): Promise<ActionResult> {
    const result = removeProfileRule(this.persisted.profiles, id, this.persisted.activeProfileId);
    if (!result.ok) return { ok: false, error: result.error };
    const activeRemoved = this.persisted.activeProfileId === id;
    this.persisted = { profiles: result.profiles, activeProfileId: result.activeProfileId };
    await this.persist();

    if (activeRemoved) {
      await this.connect(result.activeProfileId);
    } else {
      this.emitStatus();
    }
    return { ok: true, state: this.getState() };
  }

  async switchProfile(id: string): Promise<void> {
    const profile = this.persisted.profiles.find((entry) => entry.id === id);
    if (profile === undefined) {
      this.setStatus({
        state: "offline",
        profileId: this.persisted.activeProfileId,
        error: "网关不存在",
      });
      return;
    }
    if (this.persisted.activeProfileId !== id) {
      this.persisted = { ...this.persisted, activeProfileId: id };
      await this.persist();
    }
    await this.connect(id);
  }

  async restart(): Promise<void> {
    await this.connect(this.persisted.activeProfileId);
  }

  async retry(): Promise<void> {
    await this.connect(this.persisted.activeProfileId);
  }

  lastEntryUrl(): string | undefined {
    return this.lastEntryUrlValue;
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    this.generation += 1;
    await this.deps.supervisor.stop();
  }

  private async connect(profileId: string): Promise<void> {
    const generation = ++this.generation;
    const profile = this.persisted.profiles.find((entry) => entry.id === profileId);
    if (profile === undefined) {
      this.setStatus({ state: "offline", profileId, error: "网关不存在" });
      return;
    }

    this.lastEntryUrlValue = undefined;
    await this.deps.supervisor.stop();
    if (generation !== this.generation) return;

    const managedLocal = profile.kind === "local" && profile.managed;
    this.setStatus({
      state: "starting",
      profileId: profile.id,
      detail: managedLocal ? "正在启动本机网关…" : "正在连接…",
    });

    let url = profile.url;
    let token = profile.token;
    let degraded = false;
    let warning: string | undefined;
    if (managedLocal) {
      try {
        const running = await this.deps.supervisor.start(profile);
        if (generation !== this.generation) {
          await running.stop();
          return;
        }
        url = running.url;
        token = running.token;
        degraded = running.degraded;
        if (degraded) {
          warning = "本机网关使用了 Electron 内置 Node：SQLite 会话库不可用，已回退到文件存储";
        }
      } catch (error) {
        if (generation !== this.generation) return;
        this.setStatus({ state: "offline", profileId: profile.id, error: messageOf(error) });
        return;
      }
    }
    if (generation !== this.generation) return;

    if (url === "") {
      this.setStatus({ state: "offline", profileId: profile.id, error: "网关地址为空" });
      return;
    }

    this.setStatus({
      state: "starting",
      profileId: profile.id,
      url,
      detail: warning ?? "正在等待网关就绪…",
    });
    const result = await this.deps.probe(url, token);
    if (generation !== this.generation) return;

    if (!result.ok) {
      this.setStatus({
        state: "offline",
        profileId: profile.id,
        url,
        error: result.error,
        ...(warning !== undefined ? { detail: warning } : {}),
      });
      return;
    }

    this.setStatus({
      state: "online",
      profileId: profile.id,
      url,
      ...(result.version !== undefined ? { version: result.version } : {}),
      ...(result.mode !== undefined ? { mode: result.mode } : {}),
      ...(degraded ? { degraded: true } : {}),
      ...(warning !== undefined ? { detail: warning } : {}),
    });
    const entryUrl = buildGatewayEntryUrl(url, token);
    this.lastEntryUrlValue = entryUrl;
    this.emit({ type: "navigate", url: entryUrl, profileId: profile.id });
  }

  private async persist(): Promise<void> {
    try {
      await this.deps.store.save(this.persisted);
    } catch (error) {
      this.setStatus({
        state: "offline",
        profileId: this.persisted.activeProfileId,
        error: `保存网关设置失败：${messageOf(error)}`,
      });
    }
  }

  private setStatus(status: GatewayStatus): void {
    if (this.disposed) return;
    this.status = status;
    this.emitStatus();
  }

  private emitStatus(): void {
    this.emit({ type: "status", status: this.status });
  }

  private emit(event: ControllerEvent): void {
    if (this.disposed) return;
    this.deps.onEvent?.(event);
    for (const listener of this.listeners) listener(event);
  }
}