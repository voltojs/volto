/**
 * Shared test-server bootstrap for headless-server integration tests.
 *
 * Encapsulates the createServer + temp-dir + auth boilerplate that every
 * route test needs, so each test file only declares what it actually
 * exercises.
 */

import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { ModelPort } from "@volto/core";
import { createStore } from "@volto/store-jsonl";
import { createServer, type HeadlessServer } from "../server.js";

/** Minimal model port that immediately ends the turn. */
const IDLE_MODEL: ModelPort = {
  async *stream() {
    yield { type: "text_delta", text: "" };
    yield { type: "done", stopReason: "end_turn" };
  },
};

export interface TestServer {
  /** Base URL of the running server, e.g. `http://localhost:31234`. */
  url: string;
  /** Launch token for Bearer auth. */
  token: string;
  /** Primary session id used by the test. */
  sessionId: string;
  /** A second, distinct session id for cross-session isolation tests. */
  otherSessionId: string;
  /** Absolute path of the temporary VOLTO_CONFIG_DIR. */
  configDir: string;
  /** Shut down the server and clean up the temp config dir. */
  close: () => Promise<void>;
  // ── Extension points for Tasks 5/6 ──
  // Add `openEvents`, `captureMessages`, `turnCount`, `attachmentRoot`
  // here when those tasks need them.
}

export async function startTestServer(): Promise<TestServer> {
  const configDir = await fs.mkdtemp(path.join(os.tmpdir(), "volto-test-"));
  process.env["VOLTO_CONFIG_DIR"] = configDir;

  const server: HeadlessServer = await createServer({
    port: 0,
    modelPort: IDLE_MODEL,
    chatStore: createStore({ directory: configDir }),
  });

  await new Promise<void>((resolve) => server.on("listening", resolve));
  const addr = server.address();
  const port = typeof addr === "object" && addr !== null ? addr.port : 0;
  const url = `http://localhost:${port}`;
  const token = server.launchToken;

  return {
    url,
    token,
    sessionId: "test-session",
    otherSessionId: "other-session",
    configDir,
    close: async () => {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await fs.rm(configDir, { recursive: true, force: true }).catch(() => {});
    },
  };
}
