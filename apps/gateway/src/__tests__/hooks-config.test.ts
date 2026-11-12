/**
 * T10 Task 1 — hooks.json parse + compile (fail-closed, egress discipline).
 * T10 Task 2 — command hook executor (runCommandHook) + config-dir loader.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
  HooksConfigError,
  parseHooksConfig,
  buildHooksFromConfig,
  loadHooksConfig,
  runCommandHook,
} from "../config/hooks.js";
import type { HookContext } from "@volto/core";

function captureError(fn: () => unknown): unknown {
  try {
    fn();
  } catch (err) {
    return err;
  }
  throw new Error("expected the call to throw HooksConfigError, but it returned");
}

describe("parseHooksConfig", () => {
  it("parses multiple lifecycles with multiple entries each", () => {
    const map = parseHooksConfig({
      preToolUse: [
        { type: "command", command: "~/bin/check-bash.sh" },
        { type: "command", command: "python3 ~/.volto/hooks/audit.py" },
      ],
      userPromptSubmit: [{ type: "command", command: "~/bin/audit-prompt.sh" }],
    });
    expect(map.size).toBe(2);
    expect(map.get("preToolUse")).toEqual([
      { type: "command", command: "~/bin/check-bash.sh" },
      { type: "command", command: "python3 ~/.volto/hooks/audit.py" },
    ]);
    expect(map.get("userPromptSubmit")).toEqual([
      { type: "command", command: "~/bin/audit-prompt.sh" },
    ]);
  });

  it("accepts all four new lifecycles as keys", () => {
    const map = parseHooksConfig({
      userPromptSubmit: [{ type: "command", command: "a" }],
      preCompact: [{ type: "command", command: "b" }],
      subagentStop: [{ type: "command", command: "c" }],
      notification: [{ type: "command", command: "d" }],
    });
    expect(map.size).toBe(4);
    expect(map.get("preCompact")).toEqual([{ type: "command", command: "b" }]);
    expect(map.get("subagentStop")).toEqual([{ type: "command", command: "c" }]);
    expect(map.get("notification")).toEqual([{ type: "command", command: "d" }]);
  });

  it("treats an empty object as an explicit no-hook config (empty Map)", () => {
    const map = parseHooksConfig({});
    expect(map.size).toBe(0);
  });

  it("rejects an unknown lifecycle key, naming the key", () => {
    const err = captureError(() =>
      parseHooksConfig({ preTolUse: [{ type: "command", command: "x" }] }),
    );
    expect(err).toBeInstanceOf(HooksConfigError);
    expect((err as Error).message).toContain("preTolUse");
  });

  it("rejects unknown fields on an entry, naming the field", () => {
    const err = captureError(() =>
      parseHooksConfig({ preToolUse: [{ type: "command", command: "x", matcher: "*" }] }),
    );
    expect(err).toBeInstanceOf(HooksConfigError);
    expect((err as Error).message).toContain("matcher");
  });

  it("rejects a non-object root", () => {
    expect(captureError(() => parseHooksConfig([]))).toBeInstanceOf(HooksConfigError);
    expect(captureError(() => parseHooksConfig(null))).toBeInstanceOf(HooksConfigError);
    expect(captureError(() => parseHooksConfig("preToolUse"))).toBeInstanceOf(HooksConfigError);
  });

  it("rejects a lifecycle value that is not an array", () => {
    expect(
      captureError(() => parseHooksConfig({ preToolUse: { type: "command", command: "x" } })),
    ).toBeInstanceOf(HooksConfigError);
  });

  it("rejects entries that are not exactly { type: \"command\", command: string }", () => {
    expect(
      captureError(() => parseHooksConfig({ preToolUse: [{ type: "script", command: "x" }] })),
    ).toBeInstanceOf(HooksConfigError);
    expect(
      captureError(() => parseHooksConfig({ preToolUse: [{ type: "command" }] })),
    ).toBeInstanceOf(HooksConfigError);
    expect(
      captureError(() => parseHooksConfig({ preToolUse: [{ type: "command", command: 42 }] })),
    ).toBeInstanceOf(HooksConfigError);
  });
});

describe("buildHooksFromConfig", () => {
  it("compiles a handler that runs the command and returns a real outcome (no longer throws)", async () => {
    const specs = parseHooksConfig({
      preToolUse: [{ type: "command", command: "exit 0" }],
    });
    const hooks = buildHooksFromConfig(specs);
    const ctx: HookContext = { lifecycle: "preToolUse", sessionId: "sess-f" };
    await expect(hooks[0]!.handler(ctx)).resolves.toEqual({ action: "continue" });
  });

  it("surfaces a configured deny through the compiled handler", async () => {
    const specs = parseHooksConfig({
      preToolUse: [{ type: "command", command: "echo 'policy says no' >&2; exit 2" }],
    });
    const hooks = buildHooksFromConfig(specs);
    const ctx: HookContext = { lifecycle: "preToolUse" };
    await expect(hooks[0]!.handler(ctx)).resolves.toEqual({
      action: "deny",
      reason: "policy says no",
    });
  });

  it("names hooks cfg:<lifecycle>:<index> and binds the lifecycle", () => {
    const specs = parseHooksConfig({
      preToolUse: [
        { type: "command", command: "a" },
        { type: "command", command: "b" },
      ],
      notification: [{ type: "command", command: "c" }],
    });
    const hooks = buildHooksFromConfig(specs);
    expect(hooks).toHaveLength(3);
    expect(hooks.map((h) => h.name)).toEqual([
      "cfg:preToolUse:0",
      "cfg:preToolUse:1",
      "cfg:notification:0",
    ]);
    expect(hooks.map((h) => h.lifecycle)).toEqual([
      "preToolUse",
      "preToolUse",
      "notification",
    ]);
    for (const hook of hooks) {
      expect(typeof hook.handler).toBe("function");
    }
  });

  it("returns an empty array for an empty config", () => {
    expect(buildHooksFromConfig(new Map())).toEqual([]);
  });
});

// ──────────────────────────────────────────────
// T10 Task 2 — the command executor (spec D2/D5): exit-code semantics,
// stderr first-line reason, real-subprocess timeout, stdin ctx round-trip.
// Every test here spawns a REAL child process through the shell — this is
// the review focus: a mocked spawn would prove nothing about SIGTERM
// delivery or pipe plumbing.
// ──────────────────────────────────────────────
describe("runCommandHook", () => {
  const ctx: HookContext = { lifecycle: "preToolUse", sessionId: "sess-1" };

  it("exit 0 → continue (stdout is discarded, never surfaces)", async () => {
    const outcome = await runCommandHook("echo 'lorem ipsum'; exit 0", ctx);
    expect(outcome).toEqual({ action: "continue" });
  });

  it("exit 2 → deny with the trimmed FIRST stderr line only", async () => {
    const outcome = await runCommandHook(
      "printf 'not allowed\\nextra detail\\n' >&2; exit 2",
      ctx,
    );
    expect(outcome).toEqual({ action: "deny", reason: "not allowed" });
  });

  it("exit 2 with empty stderr → deny with the default no-reason text", async () => {
    const outcome = await runCommandHook("exit 2", ctx);
    expect(outcome).toEqual({
      action: "deny",
      reason: "hook denied without a reason",
    });
  });

  it("exit 1 (non-zero, not 2) → fail-closed deny naming the command and exit code", async () => {
    const outcome = await runCommandHook("echo 'boom' >&2; exit 1", ctx);
    expect(outcome.action).toBe("deny");
    if (outcome.action === "deny") {
      expect(outcome.reason).toMatch(/hook ".*" failed/);
      expect(outcome.reason).toContain("exit 1");
      expect(outcome.reason).toContain('hook "echo \'boom\' >&2; exit 1" failed: exit 1');
    }
  });

  it("spawn failure (command not found under the shell) → fail-closed deny with the spawn detail", async () => {
    // shell: true means the shell itself starts fine and reports 127 — the
    // fail-closed shape must hold for that too (non-zero, not 2).
    const outcome = await runCommandHook("definitely-not-a-real-cmd-$$$", ctx);
    expect(outcome.action).toBe("deny");
    if (outcome.action === "deny") {
      expect(outcome.reason).toMatch(/hook ".*" failed/);
    }
  });

  it(
    "REAL subprocess timeout: sleep 11 with timeoutMs 500 → SIGTERM, deny with 'timed out after 500ms', resolves in < 5s",
    async () => {
      const started = Date.now();
      const outcome = await runCommandHook("sleep 11", ctx, { timeoutMs: 500 });
      const elapsed = Date.now() - started;
      expect(outcome.action).toBe("deny");
      if (outcome.action === "deny") {
        expect(outcome.reason).toMatch(/hook ".*" failed/);
        expect(outcome.reason).toContain("timed out after 500ms");
      }
      // The call must complete promptly after SIGTERM — not hang for the
      // child's natural 11s lifetime.
      expect(elapsed).toBeLessThan(5_000);
    },
    10_000,
  );

  it("delivers ctx as JSON on stdin — the child reads prompt/sessionId back", async () => {
    // The child parses the stdin JSON and echoes two fields onto stderr;
    // exit 2 turns the first line into the deny reason, which is the only
    // observable channel back from the hook (stdout is discarded by spec).
    const nodeOneLiner =
      "node -e \"let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>{const j=JSON.parse(d);process.stderr.write(j.prompt+'|'+j.sessionId+'\\\\n');process.exit(2)})\"";
    const outcome = await runCommandHook(nodeOneLiner, {
      lifecycle: "userPromptSubmit",
      sessionId: "sess-42",
      prompt: "write tests",
    });
    expect(outcome).toEqual({
      action: "deny",
      reason: "write tests|sess-42",
    });
  });

  it("default timeout is 10s — a fast hook is unaffected", async () => {
    const outcome = await runCommandHook("exit 0", ctx);
    expect(outcome).toEqual({ action: "continue" });
  });

  it(
    "stderr collection is capped at 64 KB: a hook spamming >64KB to stderr completes, the exit-2 deny reason is the FIRST LINE of the CAPPED buffer, and the non-zero-exit path discloses the dropped count",
    async () => {
      // 70KB of stderr with a first line, then explicit deny: the reason
      // must be the first line of the CAPPED (65_536-char) buffer —
      // collection stopped appending once the cap was reached, so host
      // memory stayed bounded while the pipe kept draining. The head|tr
      // pipeline writes BLOCKING (an async process.stderr.write can be cut
      // short by process.exit, and a single writeSync hits EAGAIN once the
      // pipe buffer fills), so the full 70KB reaches the parent.
      const spamFirst =
        "{ printf 'DENY-ME\\n'; head -c 70000 /dev/zero | tr '\\000' 'x'; } >&2; exit 2";
      const denied = await runCommandHook(spamFirst, ctx);
      expect(denied).toEqual({ action: "deny", reason: "DENY-ME" });

      // Same volume, non-zero exit: fail-closed deny plus the truncation
      // note proving the capped buffer dropped the overflow (counting kept
      // after collection stopped).
      const spamExit1 = "head -c 70000 /dev/zero | tr '\\000' 'y' >&2; exit 1";
      const failed = await runCommandHook(spamExit1, ctx);
      expect(failed.action).toBe("deny");
      if (failed.action === "deny") {
        expect(failed.reason).toContain("failed: exit 1");
        // 70000 arrived, at most 65_536 were kept → >0 dropped.
        expect(failed.reason).toMatch(/stderr truncated: \d+ chars dropped/);
        const dropped = Number(failed.reason.match(/(\d+) chars dropped/)?.[1]);
        expect(dropped).toBeGreaterThan(0);
        expect(dropped).toBeLessThanOrEqual(70_000);
      }
    },
    20_000,
  );
});

// ──────────────────────────────────────────────
// T10 Task 2 — loadHooksConfig: the config-dir loader wiring consumes
// (same load discipline as egress.json / permissions.json).
// ──────────────────────────────────────────────
describe("loadHooksConfig", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "hooks-config-"));
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it("absent hooks.json → null (no hooks, treated as silence)", async () => {
    expect(await loadHooksConfig(tempDir)).toBeNull();
  });

  it("valid hooks.json → compiled Hook[] bound to their lifecycles", async () => {
    await fs.writeFile(
      path.join(tempDir, "hooks.json"),
      JSON.stringify({
        preToolUse: [{ type: "command", command: "exit 0" }],
        notification: [{ type: "command", command: "exit 0" }],
      }),
      "utf-8",
    );
    const hooks = await loadHooksConfig(tempDir);
    expect(hooks).not.toBeNull();
    expect(hooks!.map((h) => h.name)).toEqual([
      "cfg:preToolUse:0",
      "cfg:notification:0",
    ]);
    expect(hooks!.map((h) => h.lifecycle)).toEqual(["preToolUse", "notification"]);
  });

  it("malformed JSON → throws HooksConfigError (fail-closed parse)", async () => {
    await fs.writeFile(path.join(tempDir, "hooks.json"), "{ not json", "utf-8");
    await expect(loadHooksConfig(tempDir)).rejects.toBeInstanceOf(HooksConfigError);
  });

  it("unknown lifecycle key → throws HooksConfigError naming the key", async () => {
    await fs.writeFile(
      path.join(tempDir, "hooks.json"),
      JSON.stringify({ preTolUse: [{ type: "command", command: "x" }] }),
      "utf-8",
    );
    await expect(loadHooksConfig(tempDir)).rejects.toThrow(/preTolUse/);
  });
});
