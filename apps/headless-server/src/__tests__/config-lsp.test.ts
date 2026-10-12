import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { loadLspServers } from "../config/lsp.js";

let dir: string;

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "volto-lsp-config-"));
});

afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

async function writeConfig(content: string): Promise<void> {
  await fs.writeFile(path.join(dir, "lsp.json"), content, "utf-8");
}

describe("loadLspServers", () => {
  it("falls back to the built-in TypeScript server when no config file exists", async () => {
    // Spec D2: a fresh install has working code intelligence with no config,
    // and the built-in path is `typescript-language-server --stdio`.
    expect(await loadLspServers(dir)).toEqual({
      typescript: { command: "typescript-language-server", args: ["--stdio"] },
    });
  });

  it("returns a deep copy of the built-in default, so one caller cannot corrupt the next", async () => {
    const first = await loadLspServers(dir);
    first.typescript!.args!.push("--mutated");
    first.typescript!.command = "mutated";
    // The module-level default must be untouched: `args` is an array, so a
    // shallow copy would have shared it with every later session.
    expect(await loadLspServers(dir)).toEqual({
      typescript: { command: "typescript-language-server", args: ["--stdio"] },
    });
  });

  it("F-123 rejects malformed JSON instead of starting without the configured servers", async () => {
    await writeConfig("{ not json");
    await expect(loadLspServers(dir)).rejects.toThrow(/lsp\.json/);
  });

  it("F-123 returns an empty table for a valid file with an empty servers map", async () => {
    await writeConfig(JSON.stringify({ servers: {} }));
    expect(await loadLspServers(dir)).toEqual({});
  });

  it("treats an absent servers key as an explicit empty table, not as the built-in default", async () => {
    await writeConfig(JSON.stringify({}));
    expect(await loadLspServers(dir)).toEqual({});
  });

  it("reads a fully specified entry verbatim", async () => {
    await writeConfig(
      JSON.stringify({
        servers: {
          typescript: {
            command: "typescript-language-server",
            args: ["--stdio"],
            initializationParams: { maxTsServerMemory: 4096 },
          },
          python: { command: "pyright-langserver", args: ["--stdio"] },
        },
      }),
    );
    expect(await loadLspServers(dir)).toEqual({
      typescript: {
        command: "typescript-language-server",
        args: ["--stdio"],
        initializationParams: { maxTsServerMemory: 4096 },
      },
      python: { command: "pyright-langserver", args: ["--stdio"] },
    });
  });

  it("keeps an empty args array — a server with no arguments is legal", async () => {
    await writeConfig(JSON.stringify({ servers: { typescript: { command: "ts-ls", args: [] } } }));
    expect(await loadLspServers(dir)).toEqual({ typescript: { command: "ts-ls", args: [] } });
  });

  it("re-reads the file on every call, so an edit reaches the next session build", async () => {
    await writeConfig(JSON.stringify({ servers: {} }));
    expect(await loadLspServers(dir)).toEqual({});
    await writeConfig(JSON.stringify({ servers: { typescript: { command: "ts-ls" } } }));
    expect(await loadLspServers(dir)).toEqual({ typescript: { command: "ts-ls" } });
  });

  // ── Malformed documents and entries refuse the build (fail-closed) ──
  // A typo must not quietly drop a server: the user wrote the file expecting
  // it to be used, and silently running without it is the exact illusion the
  // egress / permission loaders already refuse.

  it("rejects a non-object top level", async () => {
    await writeConfig(JSON.stringify(["typescript"]));
    await expect(loadLspServers(dir)).rejects.toThrow(/must be a JSON object/);
  });

  it("rejects unknown top-level keys", async () => {
    await writeConfig(JSON.stringify({ server: {} }));
    await expect(loadLspServers(dir)).rejects.toThrow(/unknown key/);
  });

  it("rejects a servers value that is not an object", async () => {
    await writeConfig(JSON.stringify({ servers: [] }));
    await expect(loadLspServers(dir)).rejects.toThrow(/lsp\.json/);
  });

  it("rejects an entry that is not an object", async () => {
    await writeConfig(JSON.stringify({ servers: { typescript: "typescript-language-server" } }));
    await expect(loadLspServers(dir)).rejects.toThrow(/servers\["typescript"\]/);
  });

  it("rejects an entry without a command", async () => {
    await writeConfig(JSON.stringify({ servers: { typescript: { args: ["--stdio"] } } }));
    await expect(loadLspServers(dir)).rejects.toThrow(/command must be a non-empty string/);
  });

  it("rejects an empty command", async () => {
    await writeConfig(JSON.stringify({ servers: { typescript: { command: "   " } } }));
    await expect(loadLspServers(dir)).rejects.toThrow(/command/);
  });

  it("rejects an entry with unknown keys — a typo (`comand`) must not drop the server", async () => {
    await writeConfig(JSON.stringify({ servers: { typescript: { comand: "typescript-language-server" } } }));
    await expect(loadLspServers(dir)).rejects.toThrow(/unknown key/);
  });

  it("rejects non-string args", async () => {
    await writeConfig(JSON.stringify({ servers: { typescript: { command: "ts-ls", args: ["--stdio", 42] } } }));
    await expect(loadLspServers(dir)).rejects.toThrow(/args must be an array of strings/);
  });

  it("rejects a non-object initializationParams", async () => {
    await writeConfig(
      JSON.stringify({ servers: { typescript: { command: "ts-ls", initializationParams: ["oops"] } } }),
    );
    await expect(loadLspServers(dir)).rejects.toThrow(/initializationParams/);
  });

  it("rejects an empty language id", async () => {
    await writeConfig(JSON.stringify({ servers: { "": { command: "ts-ls" } } }));
    await expect(loadLspServers(dir)).rejects.toThrow(/language id/);
  });
});
