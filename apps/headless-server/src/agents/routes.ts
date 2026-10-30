/**
 * `/agents` CRUD over the agent definition registry.
 *
 * GET rescans on every request — definitions are files a user may edit in an
 * editor between calls, so a cached list would serve stale `shadowed` flags.
 * Plugin-provided definitions answer 409 (not 403) on write: the request is
 * well formed, the target simply cannot change.
 */

import {
  scanAgentSources,
  createAgentStore,
  type AgentSpec,
  type AgentEntry,
} from "@volto/sdk";

/** Wire shape for one list/create/update response — see design §10. */
export interface PublicAgentEntry {
  id: string;
  name: string;
  description: string;
  scope: "project" | "user" | "plugin";
  /** True for plugin-sourced entries: PUT/DELETE answer 409. */
  readOnly: boolean;
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

export function toPublicEntry(entry: AgentEntry): PublicAgentEntry {
  return {
    id: entry.id,
    name: entry.spec.name,
    description: entry.spec.description ?? "",
    scope: entry.scope,
    readOnly: entry.scope === "plugin",
    shadowed: entry.shadowed,
    ...(entry.filePath !== undefined ? { filePath: entry.filePath } : {}),
    spec: entry.spec,
  };
}

/**
 * Splits `<scope>:<name>`. Anything that is not `project|user|plugin` plus a
 * non-empty name is a client error, not a 404 — the id never addressed a file.
 */
export function parseAgentId(id: string): {
  scope: "project" | "user" | "plugin";
  name: string;
} {
  const idx = id.indexOf(":");
  const scope = idx > 0 ? id.slice(0, idx) : "";
  const name = idx > 0 ? id.slice(idx + 1) : "";
  if (scope !== "project" && scope !== "user" && scope !== "plugin") {
    throw new AgentsHttpError(
      400,
      `Invalid agent id ${JSON.stringify(id)}: expected "<scope>:<name>" with scope project, user, or plugin`,
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
  return { agents: (await scanAgentEntries(ctx)).map(toPublicEntry) };
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
  const { scope } = parseAgentId(id);
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

export async function deleteAgentDefinition(ctx: AgentsContext, id: string): Promise<void> {
  const { scope } = parseAgentId(id);
  if (scope === "plugin") {
    throw new AgentsHttpError(
      409,
      `Agent "${id}" is provided by a plugin and cannot be modified through this API`,
    );
  }
  const removed = await storeFor(ctx).remove(id);
  if (!removed) {
    throw new AgentsHttpError(404, `Unknown agent: ${id}`);
  }
}
