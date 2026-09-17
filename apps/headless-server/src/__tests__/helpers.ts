/**
 * Shared harness for route tests. Mirrors the createServer + listening +
 * launchToken pattern used across this directory (see server.test.ts,
 * read-endpoints.test.ts, commands.test.ts).
 */

import * as fs from "node:fs/promises";
import * as http from "node:http";
import * as os from "node:os";
import * as path from "node:path";
import type { ModelPort, ModelRequest, ToolDefinition } from "@volto/core";
import type { AgentSpec } from "@volto/sdk";
import { createServer, type HeadlessServer } from "../server.js";

export interface StartTestServerOptions {
  /** Plugin-provided agent specs the /agents routes list as read-only entries. */
  pluginAgents?: AgentSpec[];
}

export interface TestServerHandle {
  /** Base URL of the listening server, e.g. `http://localhost:31234`. */
  url: string;
  /** Bearer token for authenticated requests. */
  token: string;
  /** Id of a project created at startup, for `?projectId=` routes. */
  projectId: string;
  /**
   * Writes a project-scope agent definition into the temp project's
   * `.volto/agents/` — the directory the store writes to and the scanner
   * reads from when the server's cwd is that project.
   */
  writeProjectAgent: (name: string, systemPrompt: string) => Promise<void>;
  /** Writes a user-scope agent definition into the temp config dir's `agents/`. */
  writeUserAgent: (name: string, systemPrompt: string) => Promise<void>;
  /**
   * Tool definitions from the most recent model call — the exact list the
   * model was offered. Empty before the first turn.
   */
  captureToolDefinitions: () => ToolDefinition[];
  /**
   * Runs one turn over a fresh session's /events channel: opens SSE, POSTs
   * /messages with the harness project/provider/model binding, and resolves
   * once the turn's `turn_end` transcript event arrives.
   */
  runTurn: (message: string) => Promise<void>;
  /** Closes the server and removes this call's temp dirs. */
  close: () => Promise<void>;
}

/** Minimal definition file: frontmatter name plus the body as systemPrompt. */
function renderAgentFile(name: string, systemPrompt: string): string {
  return `---\nname: ${name}\n---\n\n${systemPrompt}\n`;
}

async function writeAgentFile(dir: string, name: string, systemPrompt: string): Promise<void> {
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, `${name}.md`), renderAgentFile(name, systemPrompt), "utf8");
}

/**
 * Boots an isolated headless server on an ephemeral port.
 *
 * Each call creates its own VOLTO_CONFIG_DIR / HOME temp dirs and a real
 * project row (POST /projects), and binds the server's default cwd to that
 * project — so project-scope agent writes land in the temp tree, never the
 * repo. HOME is redirected so os.homedir()-based scans cannot pick up the
 * machine's real ~/.claude / ~/.agents definitions.
 */
export async function startTestServer(
  options: StartTestServerOptions = {},
): Promise<TestServerHandle> {
  const configDir = await fs.mkdtemp(path.join(os.tmpdir(), "volto-route-test-"));
  const projectDir = await fs.mkdtemp(path.join(os.tmpdir(), "volto-route-project-"));
  const homeDir = await fs.mkdtemp(path.join(os.tmpdir(), "volto-route-home-"));
  process.env["VOLTO_CONFIG_DIR"] = configDir;
  const previousHome = process.env["HOME"];
  process.env["HOME"] = homeDir;

  // Per-server capturing port: records every ModelRequest so tests can assert
  // the exact tool list the model was offered (the brief's `task` description
  // checks), while still completing the turn like the old shared stub.
  const capturedRequests: ModelRequest[] = [];
  const modelPort: ModelPort = {
    async *stream(req) {
      capturedRequests.push(req);
      yield { type: "text_delta", text: "" };
      yield { type: "done", stopReason: "end_turn" };
    },
  };

  const server: HeadlessServer = await createServer({
    port: 0,
    modelPort,
    // Bind the default workspace to the temp project so /agents project-scope
    // reads and writes never touch the repository the suite runs from.
    cwd: projectDir,
    ...(options.pluginAgents ? { pluginAgents: options.pluginAgents } : {}),
  });
  await new Promise<void>((resolve) => server.on("listening", resolve));
  const addr = server.address();
  const url = `http://localhost:${typeof addr === "object" && addr ? addr.port : 0}`;
  const token = server.launchToken;

  const authHeaders = {
    "Content-Type": "application/json",
    Authorization: `Bearer ${token}`,
  };

  const createRes = await fetch(`${url}/projects`, {
    method: "POST",
    headers: authHeaders,
    body: JSON.stringify({ name: "route-test-project", path: projectDir }),
  });
  if (!createRes.ok) {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    throw new Error(`startTestServer: POST /projects failed with ${createRes.status}`);
  }
  const created = (await createRes.json()) as { id: string };

  // Provider + model the /messages turn binding must resolve — same shape
  // createTestProjectAndModel uses in server.test.ts / compact-endpoint.test.ts.
  const providerRes = await fetch(`${url}/providers`, {
    method: "POST",
    headers: authHeaders,
    body: JSON.stringify({ name: "route-test-provider", models: [{ name: "test-model", code: "test-model" }] }),
  });
  if (!providerRes.ok) {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    throw new Error(`startTestServer: POST /providers failed with ${providerRes.status}`);
  }
  const provider = (await providerRes.json()) as { id: string; models: Array<{ id: string }> };

  let turnCounter = 0;
  async function runTurn(message: string): Promise<void> {
    const sessionId = `harness-turn-${++turnCounter}`;
    // Open the /events channel first — POST /messages 409s without one — and
    // resolve on the turn's terminal transcript event (protocol v2 has no
    // terminal frame; turn end is a turn_end EVENT).
    await new Promise<void>((resolve, reject) => {
      const eventsUrl = new URL(`/events?sessionId=${encodeURIComponent(sessionId)}`, url);
      const timer = setTimeout(() => reject(new Error("runTurn: timed out waiting for turn_end")), 10_000);
      const req = http.get(eventsUrl, { headers: { Authorization: `Bearer ${token}` } }, (res) => {
        let raw = "";
        res.on("data", (chunk: Buffer) => {
          raw += chunk.toString("utf-8");
          // Parse complete SSE blocks; keep any incomplete trailing data.
          const blocks = raw.split("\n\n");
          raw = blocks.pop() ?? "";
          for (const block of blocks) {
            const fields: Record<string, string> = {};
            for (const line of block.split("\n")) {
              const idx = line.indexOf(": ");
              if (idx > 0) fields[line.slice(0, idx)] = line.slice(idx + 2);
            }
            if (fields["event"] !== "event") continue;
            const data = JSON.parse(fields["data"] ?? "null") as { type?: string };
            if (data.type === "turn_end") {
              clearTimeout(timer);
              req.destroy();
              resolve();
              return;
            }
            if (data.type === "error") {
              clearTimeout(timer);
              req.destroy();
              reject(new Error(`runTurn: turn errored: ${fields["data"]}`));
              return;
            }
          }
        });
        res.on("error", reject);

        void fetch(`${url}/messages`, {
          method: "POST",
          headers: authHeaders,
          body: JSON.stringify({
            sessionId,
            message,
            projectId: created.id,
            providerId: provider.id,
            modelId: provider.models[0]!.id,
          }),
        }).then(async (postRes) => {
          if (!postRes.ok) {
            clearTimeout(timer);
            req.destroy();
            reject(new Error(`runTurn: POST /messages failed with ${postRes.status}`));
          }
        }, reject);
      });
      req.on("error", (err) => {
        // destroy() after resolving surfaces here; ignore once settled.
        if (!req.destroyed) reject(err);
      });
    });
  }

  return {
    url,
    token,
    projectId: created.id,
    writeProjectAgent: (name, systemPrompt) =>
      writeAgentFile(path.join(projectDir, ".volto", "agents"), name, systemPrompt),
    writeUserAgent: (name, systemPrompt) =>
      writeAgentFile(path.join(configDir, "agents"), name, systemPrompt),
    captureToolDefinitions: () => capturedRequests.at(-1)?.tools ?? [],
    runTurn,
    close: async () => {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      if (previousHome === undefined) delete process.env["HOME"];
      else process.env["HOME"] = previousHome;
      // Best-effort transcript writes fired during a real turn may still be
      // landing as the server winds down, recreating a dir mid-remove — retry
      // like trajectory-e2e does rather than surfacing ENOTEMPTY.
      await fs.rm(configDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
      await fs.rm(projectDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
      await fs.rm(homeDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
    },
  };
}
