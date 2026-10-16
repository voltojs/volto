import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { createMockModelPort, extractBlockText, textScript, toolCallScript } from "@volto/core";
import type { ContentBlock, ModelEvent, ModelPort, ModelRequest } from "@volto/core";
import { createWiredAgent } from "../wiring.js";

/**
 * F-005 (roadmap F-005) — the lsp structured-block contract observed on a
 * REAL session built through the gateway wiring: `lsp_definition` returns a
 * `structured` block (kind `lsp.locations`), and the request that reaches the
 * model port carries its `text` projection VERBATIM — byte-identical to the
 * string the tool returned before structured blocks existed. The model side
 * sees zero change; the block's `data` rides along for UI/consumers.
 *
 * Nothing here stubs the LSP manager: `createWiredAgent` builds it from
 * `~/.volto/lsp.json` (redirected to a temp dir) exactly as production does,
 * and the configured server is the runtime-node fixture spawned as a real
 * child process over real stdio. Only the ModelPort is scripted.
 */

/** The runtime-node fixture, spawned as the configured language server. */
const LSP_FIXTURE = fileURLToPath(
  new URL(
    "../../../../packages/runtimes/node/src/__tests__/fixtures/lsp-server.mjs",
    import.meta.url,
  ),
);

let tempConfigDir: string;
let tempProjectDir: string;
let tempHomeDir: string;
let originalConfigDir: string | undefined;
let originalHome: string | undefined;

beforeEach(async () => {
  tempConfigDir = await fs.mkdtemp(path.join(os.tmpdir(), "volto-structured-lsp-config-"));
  tempProjectDir = await fs.mkdtemp(path.join(os.tmpdir(), "volto-structured-lsp-project-"));
  tempHomeDir = await fs.mkdtemp(path.join(os.tmpdir(), "volto-structured-lsp-home-"));
  originalConfigDir = process.env["VOLTO_CONFIG_DIR"];
  process.env["VOLTO_CONFIG_DIR"] = tempConfigDir;
  originalHome = process.env["HOME"];
  process.env["HOME"] = tempHomeDir;
});

afterEach(async () => {
  if (originalConfigDir === undefined) delete process.env["VOLTO_CONFIG_DIR"];
  else process.env["VOLTO_CONFIG_DIR"] = originalConfigDir;
  if (originalHome === undefined) delete process.env["HOME"];
  else process.env["HOME"] = originalHome;
  await fs.rm(tempConfigDir, { recursive: true, force: true });
  await fs.rm(tempProjectDir, { recursive: true, force: true });
  await fs.rm(tempHomeDir, { recursive: true, force: true });
});

/** The fixture, spawned as the configured typescript server (real stdio). */
async function writeLspConfig(): Promise<void> {
  await fs.writeFile(
    path.join(tempConfigDir, "lsp.json"),
    JSON.stringify({ servers: { typescript: { command: process.execPath, args: [LSP_FIXTURE] } } }),
    "utf-8",
  );
}

/** Capture every ModelRequest the mock port receives (spill/db-session pattern). */
function captureModelPort(scripts: ModelEvent[][]): {
  modelPort: ModelPort;
  requests: ModelRequest[];
} {
  const requests: ModelRequest[] = [];
  const inner = createMockModelPort(scripts);
  return {
    requests,
    modelPort: {
      async *stream(req) {
        requests.push(req);
        yield* inner.stream(req);
      },
    },
  };
}

/** The tool-result text the model saw on the request at `index`. */
function toolResultText(requests: ModelRequest[], index = 1): string {
  const messages = requests[index]?.messages ?? [];
  const blocks: ContentBlock[] = messages.flatMap((m) => (m.role === "tool" ? m.content : []));
  return blocks
    .filter((block) => block.type === "tool_result")
    .map((block) => extractBlockText(block))
    .join("\n");
}

describe("F-005 real session — lsp_definition returns a structured block whose text projection reaches the model unchanged", () => {
  it(
    "F-005 the wire carries the byte-identical rendering and the structured block arrives intact",
    { timeout: 60_000 },
    async () => {
      await writeLspConfig();
      await fs.mkdir(path.join(tempProjectDir, "src"), { recursive: true });
      await fs.writeFile(
        path.join(tempProjectDir, "src", "example.ts"),
        "export const answer = 42;\n",
        "utf-8",
      );

      const { modelPort, requests } = captureModelPort([
        // Round 1: ask for the definition at (3, 5) — 1-based, like read_file.
        toolCallScript(
          "call-1",
          "lsp_definition",
          JSON.stringify({ file: "src/example.ts", line: 3, character: 5 }),
        ),
        // Round 2: end the turn; the tool result lands in request 2.
        textScript("done"),
      ]);
      const agent = await createWiredAgent({ modelPort, cwd: tempProjectDir });
      try {
        const final = await agent.run("where is that defined?");

        expect(requests.length).toBe(2);

        // Byte-identical witness: build the OLD rendering in the test and
        // demand exact equality. The fixture answers definition with
        // `start.line = request.line + 1` (its deliberate shift; the request
        // position is 0-based on the wire), and renderLocation adds 1 to both
        // fields — so a (3, 5) 1-based ask renders `<path>:4:5`.
        // The path is the workspace root as configured (the manager does not
        // realpath it), and the fixture echoes the document URI back verbatim.
        const expected = `Found 1 definition(s):\n  ${path.join(tempProjectDir, "src", "example.ts")}:4:5`;
        expect(toolResultText(requests)).toBe(expected);

        // The structured block itself survived reducer + runner to the
        // provider boundary: kind is the spec's namespace and data carries
        // the fixture's own LSP-native 0-based range (line 3, not 4).
        const toolMessages = requests[1]!.messages.filter((m) => m.role === "tool");
        const toolResult = toolMessages
          .flatMap((m) => (typeof m.content === "string" ? [] : m.content))
          .filter((block) => block.type === "tool_result")
          .map((block) => (block.type === "tool_result" ? block.content : []))
          .flat()
          .find((part) => part.type === "structured");
        expect(toolResult).toBeDefined();
        if (toolResult === undefined || toolResult.type !== "structured") {
          throw new Error("unreachable: structured block assertion above throws");
        }
        expect(toolResult.kind).toBe("lsp.locations");
        expect(toolResult.data).toEqual({
          locations: [
            {
              uri: `file://${path.join(tempProjectDir, "src", "example.ts")}`,
              range: {
                start: { line: 3, character: 4 },
                end: { line: 3, character: 5 },
              },
            },
          ],
        });
        // The projection inside the block is the same string the wire saw.
        expect(toolResult.text).toBe(expected);

        expect(final.status).toBe("done");
      } finally {
        await agent.dispose();
      }
    },
  );
});
