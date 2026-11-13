/**
 * Node implementation of core's `PlanStore` port — the plan-mode artifact
 * storage the gateway manages on the agent's behalf.
 *
 * Layout mirrors the session transcript store's workspace scoping
 * (`@voltojs/store-jsonl`): `<rootDir>/sessions/<encodeWorkspaceName(projectPath)>/
 * <sessionId>.plan.md`. One plan document per session; `save` overwrites.
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { PlanStore } from "@voltojs/core";
import { encodeWorkspaceName } from "@voltojs/store-jsonl";
import { getConfigDir } from "./paths.js";

export function createPlanStore(rootDir: string = getConfigDir()): PlanStore {
  const planPath = (sessionId: string, projectPath: string): string =>
    path.join(rootDir, "sessions", encodeWorkspaceName(projectPath), `${sessionId}.plan.md`);
  return {
    async save(sessionId, projectPath, content) {
      const file = planPath(sessionId, projectPath);
      await fs.mkdir(path.dirname(file), { recursive: true });
      await fs.writeFile(file, content, "utf-8");
    },
    async read(sessionId, projectPath) {
      try {
        return await fs.readFile(planPath(sessionId, projectPath), "utf-8");
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
        throw err;
      }
    },
    async deleteBySession(sessionId, projectPath) {
      await fs.rm(planPath(sessionId, projectPath), { force: true });
    },
  };
}
