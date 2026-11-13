/**
 * LSP server config — `lsp.json` in the user config dir, loaded once per
 * session build (an edit reaches newly built sessions without a restart),
 * same pattern as `egress.json` / `permissions.json`.
 *
 * Shape:
 *   { "servers": { "typescript": { "command": "…", "args": ["--stdio"] } } }
 *
 * Fail-closed: a malformed document OR a malformed entry refuses the build
 * instead of silently running without the servers the user configured — the
 * user wrote the file expecting it to be used, so a typo (`comand`) must not
 * quietly drop a language. Unknown keys are rejected for that same reason.
 *
 * An absent FILE is not the same as an empty `servers` map:
 *
 * - absent file → the built-in TypeScript default (spec D2), so a fresh
 *   install has working code intelligence with no configuration at all;
 * - present file with an absent or empty `servers` map → an explicit empty
 *   table. The five tools stay wired and each call answers with the
 *   actionable "not configured for this language" guidance, so a deliberate
 *   opt-out is visible to the model rather than silently absent.
 */

import { ConfigCorruptError } from "./io.js";
import { getConfigStore } from "./store.js";
import type { LspServerSpec } from "@voltojs/runtime-node";

const TOP_LEVEL_KEYS = ["servers"] as const;
const SERVER_KEYS = ["command", "args", "initializationParams"] as const;

/**
 * The only language served without a config file. Kept to TypeScript on
 * purpose (spec D2): a built-in table for every language would have to be
 * maintained and probed at session-build time, while the common case — this
 * project's own source — is TypeScript. Every other language is opt-in
 * through `lsp.json`.
 */
const BUILT_IN_SERVERS: Readonly<Record<string, LspServerSpec>> = {
  typescript: { command: "typescript-language-server", args: ["--stdio"] },
};

export class LspConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LspConfigError";
  }
}

function parseServer(language: string, value: unknown): LspServerSpec {
  const where = `lsp.json: servers["${language}"]`;
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new LspConfigError(`${where} must be an object`);
  }
  const obj = value as Record<string, unknown>;
  const unknown = Object.keys(obj).filter(
    (key) => !(SERVER_KEYS as readonly string[]).includes(key),
  );
  if (unknown.length > 0) {
    throw new LspConfigError(
      `${where} has unknown key(s): ${unknown.join(", ")} — expected ${SERVER_KEYS.join(" / ")}`,
    );
  }

  const command = obj["command"];
  if (typeof command !== "string" || command.trim().length === 0) {
    throw new LspConfigError(`${where}.command must be a non-empty string`);
  }
  const spec: LspServerSpec = { command: command.trim() };

  const args = obj["args"];
  if (args !== undefined) {
    if (!Array.isArray(args) || args.some((arg) => typeof arg !== "string")) {
      throw new LspConfigError(`${where}.args must be an array of strings`);
    }
    spec.args = [...(args as string[])];
  }

  const initializationParams = obj["initializationParams"];
  if (initializationParams !== undefined) {
    if (
      typeof initializationParams !== "object" ||
      initializationParams === null ||
      Array.isArray(initializationParams)
    ) {
      throw new LspConfigError(`${where}.initializationParams must be a JSON object`);
    }
    spec.initializationParams = initializationParams as Record<string, unknown>;
  }

  return spec;
}

/**
 * Deep-copy a server spec.
 *
 * `args` (and `initializationParams`) are arrays/objects a caller may mutate,
 * so a shallow spread would leave them shared with the module-level default
 * and one session's edit would corrupt every later session.
 */
function cloneSpec(spec: LspServerSpec): LspServerSpec {
  return {
    ...spec,
    ...(spec.args === undefined ? {} : { args: [...spec.args] }),
    ...(spec.initializationParams === undefined
      ? {}
      : { initializationParams: structuredClone(spec.initializationParams) }),
  };
}

/**
 * Load the language → server table from `<configDir>/lsp.json`.
 *
 * Returns a fresh copy of the built-in default when the file is absent, and a
 * fresh empty table for an explicit empty `servers` map.
 */
export async function loadLspServers(
  configDir: string,
): Promise<Record<string, LspServerSpec | undefined>> {
  let section: unknown;
  try {
    section = (await getConfigStore(configDir).read())["lsp"];
  } catch (err) {
    if (err instanceof ConfigCorruptError) {
      throw new LspConfigError(
        `config.json could not be read: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    throw err;
  }
  if (section === undefined) {
    // A deep copy per call: the default table is module state, and a caller
    // that mutated its entry (or the `args` array) would corrupt every later
    // session in this process.
    return Object.fromEntries(
      Object.entries(BUILT_IN_SERVERS).map(([language, spec]) => [language, cloneSpec(spec)]),
    );
  }
  if (typeof section !== "object" || section === null || Array.isArray(section)) {
    throw new LspConfigError("config.json: lsp must be a JSON object");
  }
  const obj = section as Record<string, unknown>;
  const unknown = Object.keys(obj).filter(
    (key) => !(TOP_LEVEL_KEYS as readonly string[]).includes(key),
  );
  if (unknown.length > 0) {
    throw new LspConfigError(
      `lsp.json has unknown key(s): ${unknown.join(", ")} — expected ${TOP_LEVEL_KEYS.join(" / ")}`,
    );
  }

  const servers = obj["servers"];
  if (servers === undefined) return {};
  if (typeof servers !== "object" || servers === null || Array.isArray(servers)) {
    throw new LspConfigError(
      'lsp.json: "servers" must be an object mapping a language id to { "command": … }',
    );
  }

  const table: Record<string, LspServerSpec | undefined> = {};
  for (const [language, spec] of Object.entries(servers as Record<string, unknown>)) {
    if (language.trim().length === 0) {
      throw new LspConfigError("lsp.json: a server language id must be a non-empty string");
    }
    table[language] = parseServer(language, spec);
  }
  return table;
}
