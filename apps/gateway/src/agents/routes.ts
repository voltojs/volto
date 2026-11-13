/**
 * `/agents` CRUD over the agent definition registry.
 *
 * GET rescans on every request — definitions are files a user may edit in an
 * editor between calls, so a cached list would serve stale `shadowed` flags.
 * Plugin-provided definitions answer 409 (not 403) on write: the request is
 * well formed, the target simply cannot change.
 *
 * Built-in types (`general-purpose` / `explore`) ride the list as `builtin`
 * rows. They have no file, so editing one materializes a same-named
 * user-scope override (the resolution rule already lets files shadow
 * built-ins); deleting one is refused — a built-in is configurable but never
 * removable, and an override file that replaces it is equally undeletable so
 * the row cannot vanish by accident.
 */

import {
  scanAgentSources,
  createAgentStore,
  BUILTIN_AGENTS,
  findBuiltInAgent,
  type AgentSpec,
  type AgentEntry,
} from "@voltojs/sdk";

const BUILTIN_AGENT_NAMES: ReadonlySet<string> = new Set(
  BUILTIN_AGENTS.map((spec) => spec.name),
);

/** Wire shape for one list/create/update response — see design §10. */
export interface PublicAgentEntry {
  id: string;
  name: string;
  description: string;
  scope: "project" | "user" | "plugin" | "builtin";
  /** True for plugin-sourced entries: PUT/DELETE answer 409. */
  readOnly: boolean;
  /**
   * True when this row is a built-in type — the built-in itself, or a
   * same-named override file standing in for it. Built-ins are editable but
   * never deletable through this API.
   */
  builtIn?: boolean;
  /** True when a higher-priority same-named definition shadows this one. */
  shadowed: boolean;
  /** Absent for plugin entries, which have no on-disk file. */
  filePath?: string;
  spec: AgentSpec;
}

/** Error carrying the HTTP status the route should answer with. */
export class AgentsHttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "AgentsHttpError";
  }
}

/** Per-request roots the registry reads and the store writes against. */
export interface AgentsContext {
  /** Project directory — store target for `project` scope, scan root. */
  cwd: string;
  configDir: string;
  pluginSpecs: AgentSpec[];
}

/** The built-in row's wire shape: no file, editable, undeletable. */
function toPublicBuiltIn(spec: AgentSpec): PublicAgentEntry {
  return {
    id: `builtin:${spec.name}`,
    name: spec.name,
    description: spec.description ?? "",
    scope: "builtin",
    readOnly: false,
    builtIn: true,
    shadowed: false,
    spec,
  };
}

export function toPublicEntry(entry: AgentEntry): PublicAgentEntry {
  return {
    id: entry.id,
    name: entry.spec.name,
    description: entry.spec.description ?? "",
    scope: entry.scope,
    readOnly: entry.scope === "plugin",
    ...(BUILTIN_AGENT_NAMES.has(entry.spec.name) ? { builtIn: true } : {}),
    shadowed: entry.shadowed,
    ...(entry.filePath !== undefined ? { filePath: entry.filePath } : {}),
    spec: entry.spec,
  };
}

/**
 * Splits `<scope>:<name>`. Anything that is not `project|user|plugin|builtin`
 * plus a non-empty name is a client error, not a 404 — the id never addressed
 * a definition.
 */
export function parseAgentId(id: string): {
  scope: "project" | "user" | "plugin" | "builtin";
  name: string;
} {
  const idx = id.indexOf(":");
  const scope = idx > 0 ? id.slice(0, idx) : "";
  const name = idx > 0 ? id.slice(idx + 1) : "";
  if (
    scope !== "project" &&
    scope !== "user" &&
    scope !== "plugin" &&
    scope !== "builtin"
  ) {
    throw new AgentsHttpError(
      400,
      `Invalid agent id ${JSON.stringify(id)}: expected "<scope>:<name>" with scope project, user, plugin, or builtin`,
    );
  }
  if (name.length === 0) {
    throw new AgentsHttpError(400, `Invalid agent id ${JSON.stringify(id)}: missing name after ":"`);
  }
  return { scope, name };
}

function storeFor(ctx: AgentsContext) {
  return createAgentStore({ cwd: ctx.cwd, configDir: ctx.configDir });
}

/**
 * Fresh scan of every source for one workspace root; no caching — see the
 * module comment. Shared by the /agents routes and the routing-tier
 * deletion reference scan (`config/routing-tiers.ts`), so the two can never
 * disagree on which sources count as project / user / plugin.
 */
export async function scanAgentEntries(ctx: AgentsContext): Promise<AgentEntry[]> {
  const { entries } = await scanAgentSources({
    cwd: ctx.cwd,
    configDir: ctx.configDir,
    pluginSpecs: ctx.pluginSpecs,
  });
  return entries;
}

export async function listAgents(
  ctx: AgentsContext,
): Promise<{ agents: PublicAgentEntry[] }> {
  const entries = await scanAgentEntries(ctx);
  // A file definition (project / user / plugin) with a built-in name shadows
  // the built-in — the winner row is the file, so the built-in row drops out.
  // Otherwise both stay visible, built-ins first (the routing floor).
  const winners = new Set(
    entries.filter((entry) => !entry.shadowed).map((entry) => entry.spec.name),
  );
  const builtins = BUILTIN_AGENTS.filter((spec) => !winners.has(spec.name)).map(
    toPublicBuiltIn,
  );
  return { agents: [...builtins, ...entries.map(toPublicEntry)] };
}

export async function createAgentDefinition(
  ctx: AgentsContext,
  input: { scope?: unknown; spec?: unknown },
): Promise<PublicAgentEntry> {
  if (input.scope !== "project" && input.scope !== "user") {
    throw new AgentsHttpError(400, `scope must be "project" or "user"`);
  }
  const spec = input.spec;
  if (typeof spec !== "object" || spec === null || Array.isArray(spec)) {
    throw new AgentsHttpError(400, "spec is required and must be an object");
  }
  if (typeof (spec as { name?: unknown }).name !== "string" || (spec as { name: string }).name.length === 0) {
    throw new AgentsHttpError(400, "spec.name is required");
  }
  try {
    const entry = await storeFor(ctx).create({
      spec: spec as AgentSpec,
      scope: input.scope,
    });
    return toPublicEntry(entry);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (/already exists/i.test(message)) {
      throw new AgentsHttpError(409, message);
    }
    if (/invalid agent name/i.test(message)) {
      throw new AgentsHttpError(400, message);
    }
    throw err;
  }
}

export async function updateAgentDefinition(
  ctx: AgentsContext,
  id: string,
  input: { spec?: unknown },
): Promise<PublicAgentEntry> {
  const { scope, name } = parseAgentId(id);
  if (scope === "plugin") {
    throw new AgentsHttpError(
      409,
      `Agent "${id}" is provided by a plugin and cannot be modified through this API`,
    );
  }
  const spec = input.spec;
  if (typeof spec !== "object" || spec === null || Array.isArray(spec)) {
    throw new AgentsHttpError(400, "spec is required and must be an object");
  }
  if (scope === "builtin") {
    return overrideBuiltInAgent(ctx, name, spec as AgentSpec);
  }
  try {
    const updated = await storeFor(ctx).update(id, spec as AgentSpec);
    if (updated === undefined) {
      throw new AgentsHttpError(404, `Unknown agent: ${id}`);
    }
    return toPublicEntry(updated);
  } catch (err) {
    if (err instanceof AgentsHttpError) throw err;
    const message = err instanceof Error ? err.message : String(err);
    // Store-level refusals (name mismatch, unparseable file) are client errors.
    throw new AgentsHttpError(400, message);
  }
}

/**
 * Editing a built-in row writes a same-named user-scope definition — the
 * scan precedence (file > built-in) is what makes the override take effect;
 * this function only lands the file. `spec.name` is forced from the id: a
 * built-in row renames nothing, it customizes exactly one type. A pre-existing
 * user file for the same name is a conflict, not a second override: the list
 * would have shown `user:<name>` instead of `builtin:<name>`, so this id
 * arriving means the client raced the list — answer 409.
 */
async function overrideBuiltInAgent(
  ctx: AgentsContext,
  name: string,
  spec: AgentSpec,
): Promise<PublicAgentEntry> {
  if (findBuiltInAgent(name) === undefined) {
    throw new AgentsHttpError(404, `Unknown built-in agent: ${name}`);
  }
  try {
    const created = await storeFor(ctx).create({
      spec: { ...spec, name },
      scope: "user",
    });
    return toPublicEntry(created);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (/already exists/i.test(message)) {
      throw new AgentsHttpError(409, message);
    }
    if (/invalid agent name/i.test(message)) {
      throw new AgentsHttpError(400, message);
    }
    throw err;
  }
}

export async function deleteAgentDefinition(ctx: AgentsContext, id: string): Promise<void> {
  const { scope, name } = parseAgentId(id);
  if (scope === "plugin") {
    throw new AgentsHttpError(
      409,
      `Agent "${id}" is provided by a plugin and cannot be modified through this API`,
    );
  }
  // A built-in — the implicit row or the override file standing in for it —
  // cannot be deleted; the type itself must stay dispatchable.
  if (scope === "builtin" || BUILTIN_AGENT_NAMES.has(name)) {
    throw new AgentsHttpError(
      409,
      `Built-in agent "${name}" cannot be deleted — edit it instead to change its model or instructions`,
    );
  }
  const removed = await storeFor(ctx).remove(id);
  if (!removed) {
    throw new AgentsHttpError(404, `Unknown agent: ${id}`);
  }
}
