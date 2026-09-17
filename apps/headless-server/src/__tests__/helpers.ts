/**
 * Shared harness for route tests. Mirrors the createServer + listening +
 * launchToken pattern used across this directory (see server.test.ts,
 * read-endpoints.test.ts, commands.test.ts).
 */

import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { ModelPort } from "@volto/core";
import type { AgentSpec } from "@volto/sdk";
import { createServer, type HeadlessServer } from "../server.js";

/** Text-only model port — route tests never run a real turn. */
const MODEL_PORT: ModelPort = {
  async *stream() {
    yield { type: "text_delta", text: "" };
    yield { type: "done", stopReason: "end_turn" };
  },
};

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

  const server: HeadlessServer = await createServer({
    port: 0,
    modelPort: MODEL_PORT,
    // Bind the default workspace to the temp project so /agents project-scope
    // reads and writes never touch the repository the suite runs from.
    cwd: projectDir,
    ...(options.pluginAgents ? { pluginAgents: options.pluginAgents } : {}),
  });
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
    writeProjectAgent: (name, systemPrompt) =>
      writeAgentFile(path.join(projectDir, ".volto", "agents"), name, systemPrompt),
    writeUserAgent: (name, systemPrompt) =>
      writeAgentFile(path.join(configDir, "agents"), name, systemPrompt),
    close: async () => {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      if (previousHome === undefined) delete process.env["HOME"];
      else process.env["HOME"] = previousHome;
      await fs.rm(configDir, { recursive: true, force: true });
      await fs.rm(projectDir, { recursive: true, force: true });
      await fs.rm(homeDir, { recursive: true, force: true });
    },
  };
}
