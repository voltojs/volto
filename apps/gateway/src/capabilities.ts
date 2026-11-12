/**
 * What this gateway instance can actually do, and the posture it was started
 * in.
 *
 * Exactly one source: `mode` is the explicit posture chosen at startup
 * (`--serve-remote`), never inferred from a request (a header, `Origin`, a
 * source IP — Task 14's territory). `resolveCapabilities` is the single pure
 * projection from that posture plus the wiring facts onto what `GET
 * /gateway-info` publishes and what the routes gate on, so a route and the
 * advertised answer can never disagree.
 */

/** The gateway's own posture. One value per process, fixed at startup. */
export type GatewayMode = "local" | "remote";

export interface Capabilities {
  /**
   * Whether routes that open something on THIS machine's desktop
   * (`/fs/pick-directory`, `/fs/reveal`) may run. Local-only: a remote
   * caller asking for a Finder window would pop one on the host's screen
   * with nobody to answer it, and the dialog's answer would be chosen by
   * someone who is not the caller.
   */
  nativeDialogs: boolean;
  /**
   * Whether the desktop-browser automation host (Playwright driving a real
   * Chrome/Chromium on THIS machine) was actually assembled — the fact that
   * decides whether the browser tools are visible to the model, not a
   * configuration wish, and not "a web browser exists". The Web client is a
   * browser too; that is not what this flag reports.
   */
  browserAutomation: boolean;
  /**
   * Whether an LSP manager was actually assembled. Same rule as
   * `browserAutomation`.
   */
  lsp: boolean;
}

/**
 * Project the startup posture and the wiring facts onto the published
 * capabilities. Pure: no I/O, no request data.
 */
export function resolveCapabilities(input: {
  mode: GatewayMode;
  /** Whether the desktop-browser automation host was assembled (see `browserAutomation`). */
  browserAutomation: boolean;
  lsp: boolean;
}): Capabilities {
  return {
    nativeDialogs: input.mode === "local",
    browserAutomation: input.browserAutomation,
    lsp: input.lsp,
  };
}