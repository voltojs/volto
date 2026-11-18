/**
 * Types shared by the Rust side and the settings renderer. The Rust structs
 * serialize to these shapes (`camelCase`); nothing here runs at runtime in the
 * desktop host, and nothing imports Node or Tauri.
 */

/** Label of the profile the app creates on first launch. */
export const DEFAULT_PROFILE_LABEL = "本机网关";

export type GatewayKind = "local" | "remote";

export type ShellPlatform = "darwin" | "win32" | "linux";
export type ShellTheme = "system" | "light" | "dark";
export type ShellLocale = "zh" | "en";

/**
 * One gateway the app can connect to.
 *
 * - `local` + `managed`: the app starts and stops the gateway process; `url`
 *   is optional (empty means "pick a free port and learn the address from
 *   the process' own output").
 * - `local` + `!managed`: the app connects to an already running gateway.
 * - `remote`: a gateway on another machine, reached over the network with an
 *   access token.
 */
export interface GatewayProfile {
  id: string;
  label: string;
  kind: GatewayKind;
  /** Normalized origin (`http://host:port`); empty only for a managed local profile. */
  url: string;
  managed: boolean;
  /** Access token used to authenticate; never sent to the renderer. */
  token?: string;
}

/** What the renderer is allowed to see: the token becomes a presence flag. */
export interface PublicGatewayProfile extends Omit<GatewayProfile, "token"> {
  hasToken: boolean;
}

export type GatewayState = "idle" | "starting" | "online" | "offline";

export interface GatewayStatus {
  state: GatewayState;
  profileId: string;
  /** Origin actually in use (a managed local profile learns this at runtime). */
  url?: string;
  version?: string;
  mode?: "local" | "remote";
  /** True when the local gateway fell back to a degraded session store. */
  degraded?: boolean;
  /** Progress or advisory text ("starting local gateway", fallback warning). */
  detail?: string;
  /** User-facing failure text; set only when state is "offline". */
  error?: string;
}

export interface ShellState {
  profiles: PublicGatewayProfile[];
  activeProfileId: string;
  status: GatewayStatus;
  theme: ShellTheme;
  locale: ShellLocale;
  platform: ShellPlatform;
  appVersion: string;
}

/** Input from the renderer when creating or editing a profile. */
export interface ProfileDraft {
  /** Present when editing; absent when creating. */
  id?: string;
  label: string;
  kind: GatewayKind;
  url?: string;
  token?: string;
  managed?: boolean;
}

export type ActionResult =
  | { ok: true; state: ShellState }
  | { ok: false; error: string };

/** The API the preload exposes as `window.voltoShell`. */
export interface ShellApi {
  getState(): Promise<ShellState>;
  onState(listener: (state: ShellState) => void): () => void;
  switchProfile(id: string): Promise<void>;
  saveProfile(draft: ProfileDraft): Promise<ActionResult>;
  removeProfile(id: string): Promise<ActionResult>;
  restart(): Promise<void>;
  retry(): Promise<void>;
  openInstallDocs(): Promise<void>;
  scanLocal(): Promise<ActionResult>;
  closeSettings(): Promise<void>;
  reload(): Promise<void>;
  openInBrowser(): Promise<void>;
}
