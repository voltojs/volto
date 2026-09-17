/**
 * Write layer for agent definition files.
 *
 * Creates / updates / deletes `.md` files in the canonical write targets
 * (project: `<cwd>/.volto/agents`, user: `<configDir>/agents`). The
 * compatibility sources (`.claude`, `.agents`) are read by scan.ts but
 * never written here — we only ever write where we fully own the format.
 *
 * `update` rereads the file before writing so hand-authored frontmatter
 * keys and the body survive an edit made through the UI.
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { AgentSpec } from "../agent-spec.js";
import { parseAgentFile } from "./frontmatter.js";
import { fileSources, type AgentEntry } from "./scan.js";
import { serializeAgentFile } from "./serialize.js";

export interface AgentStore {
  create(opts: { spec: AgentSpec; scope: "project" | "user" }): Promise<AgentEntry>;
  update(id: string, spec: AgentSpec): Promise<AgentEntry | undefined>;
  remove(id: string): Promise<boolean>;
}

export interface CreateAgentStoreOptions {
  cwd: string;
  configDir: string;
  homeDir: string;
}

/**
 * An agent name becomes a file name, so path separators and `..` would let
 * a crafted name escape the target directory. Rejected up front.
 */
function assertValidName(name: string): void {
  if (
    name.length === 0 ||
    name === "." ||
    name === ".." ||
    name.includes("/") ||
    name.includes("\\") ||
    name.includes("\0")
  ) {
    throw new Error(`invalid agent name: ${JSON.stringify(name)}`);
  }
}

function isValidName(name: string): boolean {
  try {
    assertValidName(name);
    return true;
  } catch {
    return false;
  }
}

/** Splits `${scope}:${name}`; malformed or escaping ids yield undefined. */
function parseId(id: string): { scope: "project" | "user"; name: string } | undefined {
  const idx = id.indexOf(":");
  if (idx <= 0) return undefined;
  const scope = id.slice(0, idx);
  const name = id.slice(idx + 1);
  if (scope !== "project" && scope !== "user") return undefined;
  if (!isValidName(name)) return undefined;
  return { scope, name };
}

async function exists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

export function createAgentStore(opts: CreateAgentStoreOptions): AgentStore {
  /** The one directory this store writes to for a given scope. */
  const writeDir = (scope: "project" | "user"): string =>
    scope === "project"
      ? path.join(opts.cwd, ".volto", "agents")
      : path.join(opts.configDir, "agents");

  /** Every directory the scanner reads for a scope — duplicate checks span all of them. */
  const scopeDirs = (scope: "project" | "user"): string[] =>
    fileSources(opts)
      .filter((s) => s.scope === scope)
      .map((s) => s.dir);

  return {
    async create({ spec, scope }) {
      assertValidName(spec.name);
      for (const dir of scopeDirs(scope)) {
        const candidate = path.join(dir, `${spec.name}.md`);
        if (await exists(candidate)) {
          throw new Error(`agent "${spec.name}" already exists at ${candidate}`);
        }
      }
      const filePath = path.join(writeDir(scope), `${spec.name}.md`);
      await fs.mkdir(path.dirname(filePath), { recursive: true });
      await fs.writeFile(filePath, serializeAgentFile(spec), "utf8");
      return { id: `${scope}:${spec.name}`, scope, spec, filePath, shadowed: false };
    },

    async update(id, spec) {
      const parsedId = parseId(id);
      if (!parsedId) return undefined;
      const filePath = path.join(writeDir(parsedId.scope), `${parsedId.name}.md`);
      let raw: string;
      try {
        raw = await fs.readFile(filePath, "utf8");
      } catch {
        return undefined;
      }
      const parsed = parseAgentFile(raw, filePath);
      if ("error" in parsed) {
        // A file we cannot parse may hold keys we cannot see — refuse to
        // overwrite it rather than destroy hand-written content.
        throw new Error(`cannot update ${filePath}: ${parsed.error}`);
      }
      await fs.writeFile(
        filePath,
        serializeAgentFile(spec, parsed.unknownKeys),
        "utf8",
      );
      return {
        id: `${parsedId.scope}:${parsedId.name}`,
        scope: parsedId.scope,
        spec,
        filePath,
        shadowed: false,
      };
    },

    async remove(id) {
      const parsedId = parseId(id);
      if (!parsedId) return false;
      const filePath = path.join(writeDir(parsedId.scope), `${parsedId.name}.md`);
      try {
        await fs.unlink(filePath);
        return true;
      } catch {
        return false;
      }
    },
  };
}
