/**
 * Project registry — the list of directories the user can open a
 * conversation against. Persisted in `~/.volto/config.json` under `projects`.
 */

import * as crypto from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { getConfigDir } from "./paths.js";
import { getConfigStore } from "./store.js";

export interface Project {
  id: string;
  name: string;
  path: string;
  createdAt: number;
}

/** Thrown when a submitted project path is not an existing absolute directory. */
export class InvalidPathError extends Error {}

/** Shared 404/error text for an unresolvable project id — kept in one place so every lookup site stays byte-identical. */
export function unknownProjectMessage(projectId: string): string {
  return `Unknown project: ${projectId}`;
}

/**
 * Resolve a project id to its filesystem path via `store.findById`.
 * Returns `undefined` on a miss instead of throwing, so each caller keeps its
 * own control flow (e.g. throw for `resolveConfig`, a 404 JSON body for the
 * `/skills` route) while sharing the lookup and the error text via
 * `unknownProjectMessage`.
 */
export async function resolveProjectPath(
  store: ReturnType<typeof createProjectStore>,
  projectId: string,
): Promise<string | undefined> {
  const project = await store.findById(projectId);
  return project?.path;
}

export function createProjectStore(dir: string = getConfigDir()) {
  const store = getConfigStore(dir);

  async function readAll(): Promise<Project[]> {
    // Missing section means "no projects yet"; a corrupt document throws
    // instead of being treated as empty — see config/store.ts.
    return (await store.read())["projects"] as Project[] | undefined ?? [];
  }

  return {
    list: readAll,

    async create(input: { name: string; path: string }): Promise<Project> {
      if (!path.isAbsolute(input.path)) {
        throw new InvalidPathError(`Path must be absolute: ${input.path}`);
      }

      let isDirectory = false;
      try {
        isDirectory = (await fs.stat(input.path)).isDirectory();
      } catch {
        throw new InvalidPathError(`Path does not exist: ${input.path}`);
      }
      if (!isDirectory) {
        throw new InvalidPathError(`Path is not a directory: ${input.path}`);
      }

      const project: Project = {
        id: crypto.randomUUID(),
        name: input.name,
        path: input.path,
        createdAt: Date.now(),
      };
      await store.update<Project[]>("projects", (current) => [
        ...(current ?? []),
        project,
      ]);
      return project;
    },

    async remove(id: string): Promise<boolean> {
      let removed = false;
      await store.update<Project[]>("projects", (current) => {
        const all = current ?? [];
        const next = all.filter((p) => p.id !== id);
        removed = next.length !== all.length;
        return removed ? next : all;
      });
      return removed;
    },

    async findById(id: string): Promise<Project | null> {
      return (await readAll()).find((p) => p.id === id) ?? null;
    },
  };
}
