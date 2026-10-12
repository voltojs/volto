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
 * - `LSP_FIXTURE_PIDFILE` path to append this process's pid to (one line per
 *                         spawn: a restarted server leaves a second line, so a
 *                         test can tell "restarted once" from "never died")
 * - `LSP_FIXTURE_DIE_ONCE` marker path for `die-once` (created by the first
 *                         process that dies; absence means "not died yet")
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
 * - `diagnostics-pull` — advertise `diagnosticProvider` in `initialize`, answer
 *                  `textDocument/diagnostic` with a full report AND publish
 *                  `textDocument/publishDiagnostics` on `didOpen` (a real
 *                  server may support both). The pull path must win; if the
 *                  manager fell back to push here, the assertion would see
 *                  `source: "push"` and fail.
 * - `diagnostics-push` — advertise no `diagnosticProvider`; publish
 *                  `textDocument/publishDiagnostics` for a document right after
 *                  its `didOpen`, and again `REPUBLISH_DELAY_MS` after a
 *                  `didChange` (a real push server re-analyses on change). A
 *                  clean document is therefore "reported and empty", which is
 *                  a different fact from "not reported yet".
 * - `diagnostics-none` — advertise nothing and never publish: the "no source
 *                  has spoken yet" state.
 * - `die-on-request` — complete the `initialize` handshake, then exit(1) as
 *                  soon as `textDocument/definition` arrives. The in-flight
 *                  request is never answered: this is what a language server
 *                  crashing mid-session looks like from the manager's side.
 * - `die-once`   — like `die-on-request`, but only the FIRST process that sees
 *                  a definition request exits; a marker file records that, so
 *                  the process the manager starts next answers normally. A test
 *                  can therefore prove that a restarted server is re-synced
 *                  from scratch (fresh `didOpen`) instead of inheriting the
 *                  dead process's document versions.
 * - `die-late`   — never answer a definition request, then exit(1) after
 *                  `DIE_LATE_DELAY_MS`. Deliberately much slower than a test's
 *                  request timeout, so the exit lands on a connection that has
 *                  no pending request left: the exit-vs-timeout race that must
 *                  not settle anything twice.
 *
 * Diagnostic `severity` is the numeric LSP spelling (1 = Error … 4 = Hint),
 * because that is what a real server puts on the wire; normalizing it into the
 * contract's string union is the manager's job.
 */

import { appendFileSync, readFileSync, writeFileSync } from "node:fs";

const mode = process.argv[2] ?? process.env.LSP_FIXTURE_MODE ?? "ok";
const logPath = process.env.LSP_FIXTURE_LOG;
const pidPath = process.env.LSP_FIXTURE_PIDFILE;

if (pidPath) appendFileSync(pidPath, String(process.pid) + "\n");

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

/**
 * The diagnostic items this server reports for a document.
 *
 * Marker-driven so one mode can produce both "reported with findings" and
 * "reported and empty" without a second mode: the assertion that matters is
 * that an empty report is still a report. The optional `:<variant>` suffix is
 * echoed into the message so a test can tell two versions' reports apart and
 * prove a re-publish replaced, rather than repeated, the previous one.
 */
function diagnosticItems(uri) {
  const text = docText(uri);
  if (!text.includes("VOLTO_FIXTURE_DIAGNOSTIC")) return [];
  const variant = /VOLTO_FIXTURE_DIAGNOSTIC:(\w+)/.exec(text)?.[1];
  return [
    {
      range: {
        start: { line: 0, character: 0 },
        end: { line: 0, character: 5 },
      },
      severity: 1, // LSP DiagnosticSeverity.Error — a number on the wire
      message: variant ? `fixture diagnostic ${variant}` : "fixture diagnostic",
      source: "volto-fixture",
    },
  ];
}

/**
 * Whether this process should die on the request it is about to answer.
 *
 * `die-on-request` dies every time. `die-once` dies only until the marker file
 * exists, so the process the manager starts after the crash behaves like a
 * healthy server — which is what makes the "restart once" path observable.
 */
function shouldDie() {
  if (mode === "die-on-request") return true;
  if (mode !== "die-once") return false;
  const marker = process.env.LSP_FIXTURE_DIE_ONCE;
  if (!marker) return true;
  try {
    readFileSync(marker);
    return false;
  } catch {
    writeFileSync(marker, String(process.pid));
    return true;
  }
}

/**
 * How long a `die-late` server waits before exiting once it has been asked for
 * a definition. Far longer than the request timeout a test sets, so the timeout
 * is what the caller sees and the exit arrives with nothing pending.
 */
const DIE_LATE_DELAY_MS = 500;

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
          // Push-only and no-diagnostics servers must NOT advertise this: the
          // manager branches on its presence to choose pull over push.
          ...(mode === "diagnostics-pull"
            ? { diagnosticProvider: { interFileDependencies: false, workspaceDiagnostics: false } }
            : {}),
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
      // Exit WITHOUT answering, so the request is in flight when the process
      // disappears — the only way to exercise "reject in-flight requests".
      if (mode === "die-late") {
        setTimeout(() => process.exit(1), DIE_LATE_DELAY_MS);
        return;
      }
      if (shouldDie()) process.exit(1);
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
    case "textDocument/diagnostic":
      // A full report: the manager never sends a previousResultId, so a
      // conforming server has nothing to answer "unchanged" about.
      send({
        jsonrpc: "2.0",
        id,
        result: { kind: "full", items: diagnosticItems(uri) },
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
 * How long this server takes to re-publish after a `didChange`.
 *
 * Deliberately non-zero: while the re-analysis is in flight there is no current
 * report, and the manager must say so rather than keep serving the report it
 * cached for the version that just went away. A zero delay would let a
 * non-invalidating manager look correct whenever the publish happened to win
 * the race.
 */
const REPUBLISH_DELAY_MS = 200;

/** Send one `textDocument/publishDiagnostics` for the document's current text. */
function publishDiagnostics(uri) {
  send({
    jsonrpc: "2.0",
    method: "textDocument/publishDiagnostics",
    params: { uri, diagnostics: diagnosticItems(uri) },
  });
}

/**
 * Server-initiated notifications (messages without an id).
 *
 * Both diagnostics modes publish right after `didOpen` — that is when a real
 * server has the document and can compute its first report. Doing it in the
 * pull mode too is deliberate: the manager must prefer pull when the server
 * advertises `diagnosticProvider`, and a push-only fallback would look
 * identical if this mode never pushed.
 *
 * The push mode also re-publishes after `didChange`, `REPUBLISH_DELAY_MS`
 * later: a real push server re-analyses on change, and the gap in between is
 * where a stale cache would be handed out as a current answer.
 */
function handleNotification(msg) {
  const uri = msg.params?.textDocument?.uri;
  const publishes = mode.startsWith("diagnostics-") && mode !== "diagnostics-none";
  if (uri && publishes && msg.method === "textDocument/didOpen") {
    publishDiagnostics(uri);
    return;
  }
  if (uri && mode === "diagnostics-push" && msg.method === "textDocument/didChange") {
    setTimeout(() => publishDiagnostics(uri), REPUBLISH_DELAY_MS);
    return;
  }
  if (msg.method === "exit") process.exit(0);
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
    } else {
      handleNotification(msg);
    }
  }
}

process.stdin.on("data", (chunk) => {
  buffer = Buffer.concat([buffer, chunk]);
  drain();
});
