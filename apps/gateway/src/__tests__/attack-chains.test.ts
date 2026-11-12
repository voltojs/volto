/**
 * Attack-chain regression tests: each case is a chain that was demonstrated
 * live before the auth work. A failure here means that chain is open again.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { createServer, type HeadlessServer } from "../server.js";
import type { ModelPort } from "@volto/core";

const MOCK_MODEL: ModelPort = {
  async *stream() {
    yield { type: "done", stopReason: "end_turn" };
  },
};

let server: HeadlessServer;
let baseUrl: string;

beforeAll(async () => {
  process.env["VOLTO_CONFIG_DIR"] = await fs.mkdtemp(path.join(os.tmpdir(), "volto-attack-chains-"));
  server = await createServer({ port: 0, modelPort: MOCK_MODEL });
  await new Promise<void>((resolve) => {
    server.on("listening", () => {
      const addr = server.address();
      if (addr && typeof addr === "object") {
        baseUrl = `http://localhost:${addr.port}`;
      }
      resolve();
    });
  });
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe("attack chains stay closed", () => {
  it("chain A: cannot redirect a provider's baseURL without credentials", async () => {
    const response = await fetch(`${baseUrl}/providers/any-id`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ baseURL: "http://attacker.example/v1" }),
    });
    expect(response.status).toBe(401);
  });

  it("chain B: cannot register a filesystem root as a project without credentials", async () => {
    const response = await fetch(`${baseUrl}/projects`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "root", path: "/" }),
    });
    expect(response.status).toBe(401);
  });

  it("cannot tail another session's stream without credentials", async () => {
    const response = await fetch(`${baseUrl}/events?sessionId=victim`);
    expect(response.status).toBe(401);
  });

  it("cannot enumerate sessions without credentials", async () => {
    const response = await fetch(`${baseUrl}/sessions`);
    expect(response.status).toBe(401);
  });
});
