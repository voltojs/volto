/**
 * Shared harness for route tests. Mirrors the createServer + listening +
 * launchToken pattern used across this directory (see server.test.ts,
 * read-endpoints.test.ts, commands.test.ts).
 */

import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { ModelPort } from "@volto/core";
import { createServer, type HeadlessServer } from "../server.js";

/** Text-only model port — route tests never run a real turn. */
const MODEL_PORT: ModelPort = {
  async *stream() {
    yield { type: "text_delta", text: "" };
    yield { type: "done", stopReason: "end_turn" };
  },
};

export interface TestServerHandle {
  /** Base URL of the listening server, e.g. `http://localhost:31234`. */
  url: string;
  /** Bearer token for authenticated requests. */
  token: string;
  /** Id of a project created at startup, for `?projectId=` routes. */
  projectId: string;
  /** Closes the server and removes this call's temp dirs. */
  close: () => Promise<void>;
}

/**
 * Boots an isolated headless server on an ephemeral port.
 *
 * Each call creates its own VOLTO_CONFIG_DIR temp dir and a real project row
 * (POST /projects) so callers can exercise projectId-scoped routes without
 * depending on any shared project registry state.
 */
export async function startTestServer(): Promise<TestServerHandle> {
  const configDir = await fs.mkdtemp(path.join(os.tmpdir(), "volto-route-test-"));
  const projectDir = await fs.mkdtemp(path.join(os.tmpdir(), "volto-route-project-"));
  process.env["VOLTO_CONFIG_DIR"] = configDir;

  const server: HeadlessServer = await createServer({ port: 0, modelPort: MODEL_PORT });
  await new Promise<void>((resolve) => server.on("listening", resolve));
  const addr = server.address();
  const url = `http://localhost:${typeof addr === "object" && addr ? addr.port : 0}`;
  const token = server.launchToken;

  const createRes = await fetch(`${url}/projects`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ name: "route-test-project", path: projectDir }),
  });
  if (!createRes.ok) {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    throw new Error(`startTestServer: POST /projects failed with ${createRes.status}`);
  }
  const created = (await createRes.json()) as { id: string };

  return {
    url,
    token,
    projectId: created.id,
    close: async () => {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await fs.rm(configDir, { recursive: true, force: true });
      await fs.rm(projectDir, { recursive: true, force: true });
    },
  };
}
