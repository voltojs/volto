/**
 * Project registry — the list of directories the user can open a
 * conversation against. Persisted as `~/.volto/projects.json`.
 */

import * as crypto from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { ensureConfigDir, getConfigDir, getConfigPath } from "./paths.js";

export interface Project {
  id: string;
  name: string;
  path: string;
  createdAt: number;
}

/** Thrown when a submitted project path is not an existing absolute directory. */
export class InvalidPathError extends Error {}

export function createProjectStore(dir: string = getConfigDir()) {
  const file = getConfigPath("projects.json", dir);

  async function readAll(): Promise<Project[]> {
    try {
      return JSON.parse(await fs.readFile(file, "utf-8")) as Project[];
    } catch {
      // Missing or unreadable file means "no projects yet".
      return [];
    }
  }

  async function writeAll(projects: Project[]): Promise<void> {
    await ensureConfigDir(dir);
    await fs.writeFile(file, JSON.stringify(projects, null, 2), "utf-8");
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
      await writeAll([...(await readAll()), project]);
      return project;
    },

    async remove(id: string): Promise<boolean> {
      const all = await readAll();
      const next = all.filter((p) => p.id !== id);
      if (next.length === all.length) return false;
      await writeAll(next);
      return true;
    },

    async findById(id: string): Promise<Project | null> {
      return (await readAll()).find((p) => p.id === id) ?? null;
    },
  };
}
