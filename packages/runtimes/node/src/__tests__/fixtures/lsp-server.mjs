/**
 * Programmable LSP fixture server (plain .mjs, spawned as a real child process).
 *
 * This is deliberately NOT a mock: the LSP manager under test speaks JSON-RPC
 * over real stdio pipes to a real process. Tests can therefore assert on wire
 * traffic (every received message is appended to `LSP_FIXTURE_LOG`) and on
 * process facts (this server writes its own pid to `LSP_FIXTURE_PIDFILE`).
 *
 * Environment:
 * - `LSP_FIXTURE_MODE`    behaviour selector (see MODES below)
 * - `LSP_FIXTURE_LOG`     path to append one JSON line per received message
 * - `LSP_FIXTURE_PIDFILE` path to write this process's pid to
 *
 * The behaviour selector may also be passed as the first argument — callers
 * that spawn the fixture by command line find that clearer than mutating the
 * child's environment.
 *
 * It is a `.mjs` file on purpose: TypeScript (no `allowJs`) does not compile it
 * and `include: ["src/**\/*.test.ts"]` does not collect it, while Node still
 * runs it directly.
 *
 * MODES:
 * - `ok`         — answer initialize / definition / references / rename / hover.
 *                  `definition` returns a range whose `line` is the request's
 *                  `line + 1`, so a 1-based/0-based conversion bug is visible
 *                  to an assertion (character is echoed unchanged).
 * - `silent`     — complete the `initialize` handshake, then answer no further
 *                  request (a server that is up but wedged — exactly the case
 *                  a per-request timeout exists for).
 * - `silent-init` — answer nothing at all, not even `initialize` (proves the
 *                  handshake has its own timeout).
 *                  Later tasks add `die-on-request` and diagnostics modes.
 */

import { appendFileSync, readFileSync, writeFileSync } from "node:fs";

const mode = process.argv[2] ?? process.env.LSP_FIXTURE_MODE ?? "ok";
const logPath = process.env.LSP_FIXTURE_LOG;
const pidPath = process.env.LSP_FIXTURE_PIDFILE;

if (pidPath) writeFileSync(pidPath, String(process.pid));

function log(message) {
  if (logPath) appendFileSync(logPath, JSON.stringify(message) + "\n");
}

function send(message) {
  const body = JSON.stringify(message);
  process.stdout.write(`Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`);
}

/**
 * Read the text of a `file://` document from disk. Correct percent-encoding
 * (spaces, non-ASCII) matters here: the fixture doubles as the end-to-end
 * check for the URI helpers the manager builds.
 */
function docText(uri) {
  try {
    return readFileSync(decodeURIComponent(uri.replace(/^file:\/\//, "")), "utf8");
  } catch {
    return "";
  }
}

function handleRequest(msg) {
  const { id, method, params = {} } = msg;

  if (method === "initialize") {
    send({
      jsonrpc: "2.0",
      id,
      result: {
        capabilities: {
          textDocumentSync: 1,
          definitionProvider: true,
          referencesProvider: true,
          renameProvider: true,
          hoverProvider: true,
        },
        serverInfo: { name: "volto-lsp-fixture", version: "0.0.1" },
      },
    });
    return;
  }

  if (method === "shutdown") {
    send({ jsonrpc: "2.0", id, result: null });
    return;
  }

  const position = params.position ?? { line: 0, character: 0 };
  const uri = params.textDocument?.uri ?? "file:///unknown";

  switch (method) {
    case "textDocument/definition":
      send({
        jsonrpc: "2.0",
        id,
        result: {
          uri,
          // Deliberately shifted: the manager/consumer is responsible for
          // converting between 1-based and 0-based positions.
          range: {
            start: { line: position.line + 1, character: position.character },
            end: { line: position.line + 1, character: position.character + 1 },
          },
        },
      });
      return;
    case "textDocument/references":
      send({
        jsonrpc: "2.0",
        id,
        result: [
          {
            uri,
            range: {
              start: { line: 0, character: 0 },
              end: { line: 0, character: 1 },
            },
          },
        ],
      });
      return;
    case "textDocument/rename":
      send({
        jsonrpc: "2.0",
        id,
        result: {
          [uri]: [
            {
              range: {
                start: { line: 0, character: 0 },
                end: { line: 0, character: 1 },
              },
              newText: params.newName ?? "renamed",
            },
          ],
        },
      });
      return;
    case "textDocument/hover":
      send({
        jsonrpc: "2.0",
        id,
        result: {
          contents: {
            kind: "markdown",
            value: `fixture hover ${uri}@${position.line}:${position.character} len=${docText(uri).length}`,
          },
        },
      });
      return;
    default:
      send({
        jsonrpc: "2.0",
        id,
        error: { code: -32601, message: `method not found: ${method}` },
      });
  }
}

/**
 * Framing is byte-oriented, so the buffer stays a Buffer: `Content-Length`
 * counts UTF-8 bytes, and slicing a decoded JS string by that count silently
 * mangles every non-ASCII document (two bytes in a string where there were
 * three on the wire) — which desynchronizes the parser for the rest of the
 * session. Decode only once a whole frame has been read.
 */
let buffer = Buffer.alloc(0);
const FRAME_SEPARATOR = Buffer.from("\r\n\r\n");

function drain() {
  for (;;) {
    const headerEnd = buffer.indexOf(FRAME_SEPARATOR);
    if (headerEnd === -1) return;
    const header = buffer.subarray(0, headerEnd).toString("utf8");
    const match = /Content-Length:\s*(\d+)/i.exec(header);
    if (!match) {
      buffer = buffer.subarray(headerEnd + 4);
      continue;
    }
    const length = Number.parseInt(match[1], 10);
    const bodyStart = headerEnd + 4;
    if (buffer.length < bodyStart + length) return;

    const body = buffer.subarray(bodyStart, bodyStart + length).toString("utf8");
    buffer = buffer.subarray(bodyStart + length);

    let msg;
    try {
      msg = JSON.parse(body);
    } catch {
      continue;
    }
    // Every received message is logged, including the ones this mode
    // deliberately ignores: the log is the wire record the assertions read.
    log(msg);

    if (mode === "silent-init") continue;
    if (msg.id !== undefined && msg.id !== null) {
      if (mode === "silent" && msg.method !== "initialize") continue;
      handleRequest(msg);
    } else if (msg.method === "exit") {
      process.exit(0);
    }
  }
}

process.stdin.on("data", (chunk) => {
  buffer = Buffer.concat([buffer, chunk]);
  drain();
});
