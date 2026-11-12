import { chmod, mkdir, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import * as net from "node:net";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { describe, expect, it, vi } from "vitest";
import type * as http from "node:http";
import { bindFailureMessage, main, type CliDeps } from "../cli.js";
import { loadAccessToken, loadOrCreateAccessToken, tokenFingerprint } from "../auth/access-token.js";
import type { HeadlessServer, ServerOptions } from "../server.js";
import type { WebServerOptions } from "../web-server.js";

it("volto token 打印访问令牌", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "volto-cli-"));
  const out: string[] = [];
  const code = await main(["token"], { configDir: dir, stdout: (s) => out.push(s) });
  expect(code).toBe(0);
  expect(out.join("")).toMatch(/[A-Za-z0-9_-]{43}/);
});

it("未知子命令返回 2", async () => {
  expect(await main(["nope"], { stdout: () => {} })).toBe(2);
});

it("access token 稳定且指纹固定长度", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "volto-cli-"));
  const a = await loadOrCreateAccessToken(dir);
  expect(await loadOrCreateAccessToken(dir)).toBe(a);
  expect(tokenFingerprint(a)).toHaveLength(16);
});

/** Restores the process-wide config dir after a case touches it. */
async function withEnvRestored(fn: () => Promise<void>): Promise<void> {
  const previous = process.env["VOLTO_CONFIG_DIR"];
  try {
    await fn();
  } finally {
    if (previous === undefined) delete process.env["VOLTO_CONFIG_DIR"];
    else process.env["VOLTO_CONFIG_DIR"] = previous;
  }
}

it("volto token 只打印令牌与登录 URL 两行，且令牌跨调用稳定", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "volto-cli-"));
  const out: string[] = [];
  expect(await main(["token"], { configDir: dir, stdout: (s) => out.push(s) })).toBe(0);
  expect(await main(["token"], { configDir: dir, stdout: (s) => out.push(s) })).toBe(0);

  // Exactly two lines per invocation — no banner, no fingerprint, no advice.
  expect(out.join("").match(/\n/g)).toHaveLength(4);
  const lines = out.join("").split("\n").filter((line) => line !== "");
  expect(lines).toHaveLength(4); // two invocations × two lines

  const [token, open] = lines;
  expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
  expect(open).toBe(`Open: http://127.0.0.1:3100/?token=${token}`);
  expect(lines[2]).toBe(token);
  expect(lines[3]).toBe(open);

  // R6: the printed token is the one persisted for this config dir.
  expect((await readFile(path.join(dir, "access-token"), "utf-8")).trim()).toBe(token);
});

it("access token 文件权限是 0600，损坏则重写", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "volto-cli-"));
  const token = await loadOrCreateAccessToken(dir);
  const file = path.join(dir, "access-token");
  expect((await stat(file)).mode & 0o777).toBe(0o600);

  await writeFile(file, "not-a-token");
  await chmod(file, 0o644);
  const rewritten = await loadOrCreateAccessToken(dir);
  expect(rewritten).toMatch(/^[A-Za-z0-9_-]{43}$/);
  expect(rewritten).not.toBe("not-a-token");
  expect((await stat(file)).mode & 0o777).toBe(0o600);
  expect(token).not.toBe(rewritten);
});

it("token --rotate 换新令牌并让指纹随之改变", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "volto-cli-"));
  const before = await loadOrCreateAccessToken(dir);
  const out: string[] = [];
  expect(await main(["token", "--rotate"], { configDir: dir, stdout: (s) => out.push(s) })).toBe(0);

  const after = await loadOrCreateAccessToken(dir);
  expect(after).not.toBe(before);
  expect(out.join("")).toContain(`Open: http://127.0.0.1:3100/?token=${after}`);
  expect(tokenFingerprint(after)).not.toBe(tokenFingerprint(before));
});

it("未知子命令在 stderr 打印用法并以 2 退出", async () => {
  const errors: string[] = [];
  expect(await main(["nope"], { stdout: () => {}, stderr: (s) => errors.push(s) })).toBe(2);
  expect(errors.join("")).toContain("Usage: volto");
  expect(errors.join("")).toContain("Unknown command: nope");
});

it("非法参数以 2 退出", async () => {
  expect(await main(["--port", "abc"], { stdout: () => {}, stderr: () => {} })).toBe(2);
  expect(await main(["--open", "--no-open"], { stdout: () => {}, stderr: () => {} })).toBe(2);
});

/**
 * A stand-in for the http.Server createServer returns. `close` resolves
 * immediately and `address()` reports the port the CLI was asked for, so no
 * socket is ever bound.
 */
function fakeServer(port: number, token = "T".repeat(43)): HeadlessServer {
  return {
    authenticatedUrl: `http://127.0.0.1:${port}/?token=${token}`,
    address: () => ({ address: "127.0.0.1", family: "IPv4", port }),
    // Already listening: the CLI must not rely on an event the real server
    // fires later, but it must cope when a stub reports it up front too.
    listening: true,
    once: () => undefined,
    close: (cb?: () => void) => {
      cb?.();
      return undefined as never;
    },
  } as unknown as HeadlessServer;
}

it("默认命令把解析后的选项交给 startServer 并打印两行启动信息", async () => {
  await withEnvRestored(async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "volto-cli-"));
    const out: string[] = [];
    const opened: string[] = [];
    const seen: ServerOptions[] = [];
    const startServer = async (opts: ServerOptions) => {
      seen.push(opts);
      return fakeServer(opts.port ?? 0);
    };

    let waited = 0;
    const code = await main(["--port", "0", "--config-dir", dir], {
      startServer,
      stdout: (s) => out.push(s),
      openBrowser: (url) => opened.push(url),
      waitForShutdown: async () => {
        waited += 1;
      },
    });

    expect(code).toBe(0);
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ port: 0, host: "127.0.0.1" });
    expect(waited).toBe(1);
    expect(process.env["VOLTO_CONFIG_DIR"]).toBe(dir);

    const lines = out.join("").split("\n").filter((line) => line !== "");
    expect(lines[0]).toMatch(/^volto gateway \d+\.\d+\.\d+ listening on http:\/\/127\.0\.0\.1:\d+$/);
    expect(lines[1]).toBe(`Open: http://127.0.0.1:0/?token=${"T".repeat(43)}`);
    // Local mode opens the browser with the authenticated URL.
    expect(opened).toEqual([`http://127.0.0.1:0/?token=${"T".repeat(43)}`]);
  });
});

it("端口尚未绑定完成时等 listening 再打印（--port 0 的真实端口）", async () => {
  await withEnvRestored(async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "volto-cli-"));
    const out: string[] = [];
    // createServer returns before listen completes: address() is null and the
    // real port arrives with the `listening` event.
    let listening = false;
    let bound: { type: "listening"; cb: () => void } | undefined;
    const late = {
      authenticatedUrl: `http://127.0.0.1:0/?token=${"T".repeat(43)}`,
      address: () => (listening ? { address: "127.0.0.1", family: "IPv4", port: 54321 } : null),
      get listening() {
        return listening;
      },
      once: (event: string, cb: () => void) => {
        if (event === "listening") bound = { type: "listening", cb };
        return undefined;
      },
      // The CLI unsubscribes the losing event; a stub without this would
      // crash the very success path it is meant to prove.
      removeListener: () => undefined,
      close: (cb?: () => void) => {
        cb?.();
        return undefined as never;
      },
    } as unknown as HeadlessServer;

    const running = main(["--port", "0", "--no-open", "--config-dir", dir], {
      startServer: async () => late,
      stdout: (s) => out.push(s),
      openBrowser: () => {},
      waitForShutdown: async () => {},
    });

    // Let main reach the wait, then fire the event the real server fires.
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(out).toEqual([]);
    listening = true;
    bound?.cb();
    expect(await running).toBe(0);

    const text = out.join("");
    expect(text).toContain("listening on http://127.0.0.1:54321\n");
    expect(text).toContain("Open: http://127.0.0.1:54321/?token=");
  });
});

/**
 * Occupy a real port and start the gateway command on it. The bind fails, so
 * the two startup lines — the stdout contract scripts parse — must NOT be
 * printed: "listening" for a port this process never held is a lie, and the
 * caller has no way to tell it from a real one.
 *
 * A real socket (not a stub) is what makes this test touch the boundary: the
 * `error` comes from the OS, with its own code.
 */
it("端口被占用时以非零退出、stderr 带 EADDRINUSE，且不打印任何 listening 行", async () => {
  await withEnvRestored(async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "volto-cli-"));
    const blocker = net.createServer();
    await new Promise<void>((resolve) => blocker.listen(0, "127.0.0.1", () => resolve()));
    const address = blocker.address();
    const port = typeof address === "object" && address !== null ? address.port : 0;
    expect(port).toBeGreaterThan(0);

    const out: string[] = [];
    const errors: string[] = [];
    try {
      const code = await main(["--port", String(port), "--no-open", "--config-dir", dir], {
        stdout: (s) => out.push(s),
        stderr: (s) => errors.push(s),
        openBrowser: () => {},
        waitForShutdown: async () => {},
      });
      expect(code).not.toBe(0);
    } finally {
      await new Promise<void>((resolve) => blocker.close(() => resolve()));
    }

    expect(errors.join("")).toContain("EADDRINUSE");
    expect(errors.join("")).toContain(`127.0.0.1:${port}`);
    // Zero startup lines: not "listening on", not "Open:".
    expect(out.join("")).not.toContain("listening");
    expect(out.join("")).not.toContain("Open:");
    expect(out.join("")).toBe("");
  });
});

/**
 * The two events cannot both decide the outcome. `listening` first must not
 * be undone by a later `error` (which a real server would otherwise raise as
 * an uncaught exception), and `error` first must not be papered over by a
 * late `listening`.
 */
it("listening 之后到来的 error 不改变结果，error 之后到来的 listening 也不改变", async () => {
  await withEnvRestored(async () => {
    type Handler = (arg?: unknown) => void;
    const makeStub = (boundPort: number, initial: boolean) => {
      const handlers = new Map<string, Handler[]>();
      let listening = initial;
      const stub = {
        authenticatedUrl: `http://127.0.0.1:0/?token=${"T".repeat(43)}`,
        address: () => (listening ? { address: "127.0.0.1", family: "IPv4", port: boundPort } : null),
        get listening() {
          return listening;
        },
        once: (event: string, cb: Handler) => {
          handlers.set(event, [...(handlers.get(event) ?? []), cb]);
          return stub;
        },
        removeListener: (event: string, cb: Handler) => {
          handlers.set(event, (handlers.get(event) ?? []).filter((entry) => entry !== cb));
          return stub;
        },
        fire: (event: string, arg?: unknown) => {
          if (event === "listening") listening = true;
          const list = [...(handlers.get(event) ?? [])];
          handlers.set(event, []);
          for (const cb of list) cb(arg);
        },
        pending: (event: string) => (handlers.get(event) ?? []).length,
        close: (cb?: () => void) => {
          cb?.();
          return undefined as never;
        },
      };
      return stub;
    };

    // Case 1: listening fires, then a late error arrives — the CLI stays up.
    const dirA = await mkdtemp(path.join(tmpdir(), "volto-cli-"));
    const lateError = makeStub(54321, false);
    const outA: string[] = [];
    const errA: string[] = [];
    const runA = main(["--port", "0", "--no-open", "--config-dir", dirA], {
      startServer: (async () => lateError) as unknown as CliDeps["startServer"],
      stdout: (s) => outA.push(s),
      stderr: (s) => errA.push(s),
      openBrowser: () => {},
      waitForShutdown: async () => {},
    });
    await new Promise((resolve) => setTimeout(resolve, 10));
    lateError.fire("listening");
    expect(await runA).toBe(0);
    // The error listener was removed when listening won: a late error is the
    // server's own business, never an uncaught exception from the wait.
    expect(lateError.pending("error")).toBe(0);
    expect(outA.join("")).toContain("listening on http://127.0.0.1:54321");
    expect(errA.join("")).not.toContain("Could not listen");

    // Case 2: error fires, then a late listening arrives — success stays off.
    const dirB = await mkdtemp(path.join(tmpdir(), "volto-cli-"));
    const lateListening = makeStub(54322, false);
    const outB: string[] = [];
    const errB: string[] = [];
    const runB = main(["--port", "0", "--no-open", "--config-dir", dirB], {
      startServer: (async () => lateListening) as unknown as CliDeps["startServer"],
      stdout: (s) => outB.push(s),
      stderr: (s) => errB.push(s),
      openBrowser: () => {},
      waitForShutdown: async () => {},
    });
    await new Promise((resolve) => setTimeout(resolve, 10));
    lateListening.fire("error", Object.assign(new Error("listen EADDRINUSE"), { code: "EADDRINUSE" }));
    expect(await runB).not.toBe(0);
    // The listening listener was removed when the error won.
    expect(lateListening.pending("listening")).toBe(0);
    expect(outB.join("")).not.toContain("listening");
    expect(errB.join("")).toContain("EADDRINUSE");
  });
});

it("默认命令让 createServer 不再自行打印启动日志", async () => {
  await withEnvRestored(async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "volto-cli-"));
    const seen: ServerOptions[] = [];
    const code = await main(["--no-open", "--config-dir", dir], {
      startServer: async (opts) => {
        seen.push(opts);
        return fakeServer(opts.port ?? 0);
      },
      stdout: () => {},
      openBrowser: () => {},
      waitForShutdown: async () => {},
    });
    expect(code).toBe(0);
    // Silent sink: the CLI prints the two lines, and the authenticated URL
    // must not be duplicated (or leak) through the server's own logging.
    expect(seen[0]?.log?.("x")).toBeUndefined();
  });
});

it("--no-open 不打开浏览器，--host/--web-dir 透传", async () => {
  await withEnvRestored(async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "volto-cli-"));
    const opened: string[] = [];
    const seen: ServerOptions[] = [];
    const code = await main(
      ["--port", "3210", "--host", "localhost", "--web-dir", "/tmp/volto-web", "--no-open", "--config-dir", dir],
      {
        startServer: async (opts) => {
          seen.push(opts);
          return fakeServer(opts.port ?? 0);
        },
        stdout: () => {},
        openBrowser: (url) => opened.push(url),
        waitForShutdown: async () => {},
      },
    );

    expect(code).toBe(0);
    expect(seen[0]).toMatchObject({ port: 3210, host: "localhost", webRoot: "/tmp/volto-web" });
    expect(opened).toEqual([]);
  });
});

it("非 loopback 绑定未加 --serve-remote 时拒绝启动", async () => {
  await withEnvRestored(async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "volto-cli-"));
    const errors: string[] = [];
    const startServer = vi.fn();
    const code = await main(["--host", "0.0.0.0", "--config-dir", dir], {
      startServer: startServer as unknown as CliDeps["startServer"],
      stdout: () => {},
      stderr: (s) => errors.push(s),
      openBrowser: () => {},
      waitForShutdown: async () => {},
    });

    expect(code).toBe(1);
    expect(startServer).not.toHaveBeenCalled();
    expect(errors.join("")).toContain("--serve-remote");
  });
});

it("--serve-remote 放行非 loopback 绑定：选项透传，警告只走 stderr", async () => {
  await withEnvRestored(async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "volto-cli-"));
    const out: string[] = [];
    const errors: string[] = [];
    const opened: string[] = [];
    const seen: ServerOptions[] = [];
    const code = await main(
      ["--host", "0.0.0.0", "--port", "0", "--serve-remote", "--config-dir", dir],
      {
        startServer: async (opts) => {
          seen.push(opts);
          return fakeServer(opts.port ?? 0);
        },
        stdout: (s) => out.push(s),
        stderr: (s) => errors.push(s),
        openBrowser: (url) => opened.push(url),
        waitForShutdown: async () => {},
      },
    );

    expect(code).toBe(0);
    expect(seen[0]).toMatchObject({ host: "0.0.0.0", serveRemote: true });
    // R28: stdout stays exactly the two promised lines — the remote notice
    // must not appear in a stream a script parses.
    const lines = out.join("").split("\n").filter((line) => line !== "");
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatch(/^volto gateway \d+\.\d+\.\d+ listening on http:\/\/0\.0\.0\.0:\d+$/);
    // The Open line comes from the server's own authenticatedUrl (the stub's
    // host is fixed there); only its port is re-derived here.
    expect(lines[1]).toBe(`Open: http://127.0.0.1:0/?token=${"T".repeat(43)}`);
    expect(errors.join("")).toContain("native dialogs disabled");
    // A remote bind does not pop a browser on whatever machine ran the CLI.
    expect(opened).toEqual([]);
  });
});

it("本地模式不把 serveRemote 传给 createServer", async () => {
  await withEnvRestored(async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "volto-cli-"));
    const seen: ServerOptions[] = [];
    expect(
      await main(["--no-open", "--config-dir", dir], {
        startServer: async (opts) => {
          seen.push(opts);
          return fakeServer(opts.port ?? 0);
        },
        stdout: () => {},
        openBrowser: () => {},
        waitForShutdown: async () => {},
      }),
    ).toBe(0);
    expect(seen[0]?.serveRemote).toBe(false);
  });
});

it("startServer 抛错时以 1 退出并把消息写到 stderr", async () => {
  await withEnvRestored(async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "volto-cli-"));
    const errors: string[] = [];
    const code = await main(["--config-dir", dir], {
      startServer: async () => {
        throw new Error("EADDRINUSE: port 3100 in use");
      },
      stdout: () => {},
      stderr: (s) => errors.push(s),
      openBrowser: () => {},
      waitForShutdown: async () => {},
    });
    expect(code).toBe(1);
    expect(errors.join("")).toContain("EADDRINUSE");
  });
});

it("doctor 每项检查独立成行，全部通过时退出 0", async () => {
  await withEnvRestored(async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "volto-cli-"));
    const out: string[] = [];
    const code = await main(["doctor", "--port", "0", "--config-dir", dir], {
      stdout: (s) => out.push(s),
    });

    const text = out.join("");
    expect(text).toMatch(/^node version: /m);
    expect(text).toMatch(/^sandbox backend: /m);
    expect(text).toMatch(/^sandbox binary: /m);
    expect(text).toMatch(/^config dir: ok /m);
    expect(text).toMatch(/^sqlite: (ok|warn) \(/m);
    expect(text).toMatch(/^port: /m);
    // Every check reports one status word, so a bare "ok" line means a check
    // silently dropped out.
    for (const line of text.split("\n").filter((l) => l !== "")) {
      expect(line).toMatch(/^[a-z ]+: (ok|warn|fail) \(/);
    }
    // A hard failure (no sandbox backend/binary) is the only reason to exit 1.
    const hardFailure = /^(sandbox backend|sandbox binary): fail /m.test(text);
    expect(code).toBe(hardFailure ? 1 : 0);
  });
});
it("doctor 在 VOLTO_SESSION_STORE=file 时报 file (forced)，且不改动 sessions.db", async () => {
  await withEnvRestored(async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "volto-cli-"));
    const out: string[] = [];
    const previous = process.env["VOLTO_SESSION_STORE"];
    process.env["VOLTO_SESSION_STORE"] = "file";
    try {
      const code = await main(["doctor", "--port", "0", "--config-dir", dir], {
        stdout: (s) => out.push(s),
      });
      expect(code).toBe(0);
    } finally {
      if (previous === undefined) delete process.env["VOLTO_SESSION_STORE"];
      else process.env["VOLTO_SESSION_STORE"] = previous;
    }
    expect(out.join("")).toMatch(/^sqlite: ok \(file \(forced\)\)$/m);
    // The escape hatch picks the file store; it does not create the database.
    await expect(stat(path.join(dir, "db", "sessions.db"))).rejects.toMatchObject({ code: "ENOENT" });
  });
});

/**
 * `doctor` with a database the driver cannot open: a plain file at
 * `db/sessions.db` is not a database, so the real store throws
 * `file is not a database`. Nothing is injected — this exercises the same
 * classification and wording the server would print.
 */
it("doctor 把「库打不开」报成 warn (file (fallback: db unusable))，警告只打一次且不判死", async () => {
  await withEnvRestored(async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "volto-cli-"));
    await mkdir(path.join(dir, "db"), { recursive: true });
    await writeFile(path.join(dir, "db", "sessions.db"), "not a sqlite database", "utf-8");
    const before = await stat(path.join(dir, "db", "sessions.db"));

    const out: string[] = [];
    const err: string[] = [];
    const code = await main(["doctor", "--port", "0", "--config-dir", dir], {
      stdout: (s) => out.push(s),
      stderr: (s) => err.push(s),
    });

    // Not a hard failure: the gateway would start on the file store.
    const hardFailure = /^(sandbox backend|sandbox binary): fail /m.test(out.join(""));
    expect(code).toBe(hardFailure ? 1 : 0);
    expect(out.join("")).toMatch(
      /^sqlite: warn \(file \(fallback: db unusable\)\)$/m,
    );
    // The long explanation appears exactly once, on stderr, after the table.
    const warning = err.join("");
    expect(warning.match(/volto: WARNING/g)).toHaveLength(1);
    expect(warning).toContain(path.join(dir, "db", "sessions.db"));
    expect(warning).toContain("EXISTS but cannot be opened");
    expect(warning).toContain("NOT being read");
    // And the database itself is untouched.
    const after = await stat(path.join(dir, "db", "sessions.db"));
    expect(after.mtimeMs).toBe(before.mtimeMs);
    expect(await readFile(path.join(dir, "db", "sessions.db"), "utf-8")).toBe("not a sqlite database");
  });
});

it("doctor 在 sqlite 正常时只报 sqlite (primary)，不打任何警告", async () => {
  await withEnvRestored(async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "volto-cli-"));
    const out: string[] = [];
    const err: string[] = [];
    const code = await main(["doctor", "--port", "0", "--config-dir", dir], {
      stdout: (s) => out.push(s),
      stderr: (s) => err.push(s),
    });

    const hardFailure = /^(sandbox backend|sandbox binary): fail /m.test(out.join(""));
    expect(code).toBe(hardFailure ? 1 : 0);
    expect(out.join("")).toMatch(/^sqlite: ok \(sqlite \(primary\)\)$/m);
    expect(err.join("")).not.toContain("volto: WARNING");
  });
});

/** A listening `web` server stand-in: only the address and close are used. */
function fakeWebServer(port: number): http.Server {
  return {
    listening: true,
    address: () => ({ address: "127.0.0.1", family: "IPv4", port }),
    once: () => undefined,
    close: (cb?: () => void) => {
      cb?.();
      return undefined as never;
    },
  } as unknown as http.Server;
}

it("绑定失败的信息用系统错误码，且 --port 0 不会把 0 当成端口打印", () => {
  const withCode = Object.assign(new Error("listen EADDRINUSE: address already in use"), { code: "EADDRINUSE" });
  expect(bindFailureMessage("127.0.0.1", 3100, withCode)).toBe("Could not listen on 127.0.0.1:3100: EADDRINUSE\n");
  // `--port 0` lets the OS choose: naming ":0" would send the reader looking
  // for a process bound to a port nobody asked for.
  const dynamic = bindFailureMessage("127.0.0.1", 0, withCode);
  expect(dynamic).toBe("Could not listen on 127.0.0.1:<system-assigned port>: EADDRINUSE\n");
  expect(dynamic).not.toContain(":0:");
  // No OS code (some platforms/wrappers): fall back to the message, never blank.
  expect(bindFailureMessage("127.0.0.1", 3100, new Error("boom"))).toBe("Could not listen on 127.0.0.1:3100: boom\n");
});

/**
 * `volto web` shares `serve`'s bind-then-announce step, so it must fail the
 * same way: no startup lines on a bind that never happened, the OS error code
 * on stderr, a non-zero exit. Same real socket as the `serve` case — a stub
 * would prove the code path, not the boundary.
 */
it("volto web 端口被占用时以非零退出、stderr 带 EADDRINUSE，且不打印任何启动行", async () => {
  await withEnvRestored(async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "volto-cli-"));
    // `web` binds every interface (`::`, dual-stack) when no --host is given,
    // and on macOS a `::` bind co-exists with a `127.0.0.1` one on the same
    // port. So the blocker has to be the same shape, or this test would pass
    // on a bind that never failed.
    const blocker = net.createServer();
    await new Promise<void>((resolve, reject) => {
      blocker.once("error", reject);
      // `ipv6Only: false` is already the default (dual-stack); stated so the
      // shape matching `web`'s own bind is explicit rather than incidental.
      blocker.listen({ port: 0, host: "::", ipv6Only: false }, () => resolve());
    });
    const address = blocker.address();
    const port = typeof address === "object" && address !== null ? address.port : 0;
    expect(port).toBeGreaterThan(0);

    const out: string[] = [];
    const errors: string[] = [];
    try {
      const code = await main(["web", "--port", String(port), "--config-dir", dir], {
        stdout: (s) => out.push(s),
        stderr: (s) => errors.push(s),
        waitForShutdown: async () => {},
      });
      expect(code).not.toBe(0);
    } finally {
      await new Promise<void>((resolve) => blocker.close(() => resolve()));
    }

    // Byte-identical wording to `serve`: `startWebServer` rejects on a bind
    // failure, so this arrives through the startWeb catch, not the helper.
    expect(errors.join("")).toBe(`Could not listen on 127.0.0.1:${port}: EADDRINUSE\n`);
    // None of the three startup lines: not "listening", not "Open:", not "Login:".
    expect(out.join("")).toBe("");
  });
});

it("volto web 用默认端口/网关/包内 web 目录启动并打印两行", async () => {
  await withEnvRestored(async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "volto-cli-"));
    const seen: WebServerOptions[] = [];
    const out: string[] = [];
    const code = await main(["web", "--config-dir", dir], {
      startWeb: async (opts) => {
        seen.push(opts);
        return fakeWebServer(6100);
      },
      stdout: (s) => out.push(s),
      waitForShutdown: async () => {},
    });

    expect(code).toBe(0);
    expect(seen[0]).toMatchObject({ port: 6100, gateway: "http://127.0.0.1:3100" });
    // The packaged build ships beside the compiled CLI, never an absolute path.
    expect(seen[0]?.webRoot).toBe(path.resolve(__dirname, "../../web"));
    expect(seen[0]?.webRoot).toMatch(/apps\/gateway\/web$/);

    const lines = out.join("").split("\n").filter((line) => line !== "");
    expect(lines[0]).toBe("volto web 0.1.0 listening on http://127.0.0.1:6100 -> http://127.0.0.1:3100");
    expect(lines[1]).toBe("Open: http://127.0.0.1:6100/");
    // The persistent token is printed, but it is NOT an accepted credential
    // until Task 12 — the line is informational, not a working login yet.
    expect(lines[2]).toMatch(/^Login: http:\/\/127\.0\.0\.1:6100\/\?token=[A-Za-z0-9_-]{43}$/);
    expect(lines).toHaveLength(3);
  });
});

it("access token 的值与是否新建：已有文件不重建，缺失时新建", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "volto-cli-"));
  // Missing file: this call creates it, and the next call reads that one.
  const first = await loadAccessToken(dir);
  expect(first.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
  expect(first.created).toBe(true);
  const second = await loadAccessToken(dir);
  expect(second).toEqual({ token: first.token, created: false });

  // A corrupt file is unusable, so replacing it is a creation too.
  const corruptDir = await mkdtemp(path.join(tmpdir(), "volto-cli-"));
  await writeFile(path.join(corruptDir, "access-token"), "not-a-token");
  const rewritten = await loadAccessToken(corruptDir);
  expect(rewritten.created).toBe(true);
  expect(rewritten.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
});

/**
 * `volto web` prints a `Login:` URL built from the access token in ITS config
 * directory. When that token is new, the gateway on the other end almost
 * certainly reads another directory and will refuse the link — so the command
 * says so, on stderr, before the user spends time on a 401.
 */
describe("volto web 的 Login: 令牌归属提示", () => {
  /** Run `volto web` against a stub server; returns stdout, stderr and the code. */
  async function runWebIn(dir: string): Promise<{ out: string; err: string; code: number }> {
    const stdout: string[] = [];
    const stderr: string[] = [];
    const code = await main(["web", "--config-dir", dir], {
      startWeb: async () => fakeWebServer(6100),
      stdout: (s) => stdout.push(s),
      stderr: (s) => stderr.push(s),
      waitForShutdown: async () => {},
    });
    return { out: stdout.join(""), err: stderr.join(""), code };
  }

  it("令牌是本次新建的：stdout 仍是三行，stderr 警告它只对同一个 --config-dir 生效", async () => {
    await withEnvRestored(async () => {
      const dir = await mkdtemp(path.join(tmpdir(), "volto-cli-"));
      const { out, err, code } = await runWebIn(dir);

      expect(code).toBe(0);
      const lines = out.split("\n").filter((line) => line !== "");
      expect(lines).toHaveLength(3);
      expect(lines[2]).toMatch(/^Login: http:\/\/127\.0\.0\.1:6100\/\?token=[A-Za-z0-9_-]{43}$/);

      // The warning names what was done, the condition, and the way out.
      expect(err).toContain("A new access token was created");
      expect(err).toContain(dir);
      expect(err).toContain(`--config-dir ${dir}`);
      expect(err).toContain("volto token");
      // It does not echo stdout's contract line back, nor the token itself.
      expect(err).not.toMatch(/^Login: /m);
      expect(err).not.toMatch(/token=[A-Za-z0-9_-]{43}/);
    });
  });

  it("令牌已存在：不警告，stdout 的三行不变", async () => {
    await withEnvRestored(async () => {
      const dir = await mkdtemp(path.join(tmpdir(), "volto-cli-"));
      const existing = await loadOrCreateAccessToken(dir);
      const { out, err, code } = await runWebIn(dir);

      expect(code).toBe(0);
      expect(err).toBe("");
      expect(out).toContain(`Login: http://127.0.0.1:6100/?token=${existing}`);
      expect(out.split("\n").filter((line) => line !== "")).toHaveLength(3);
    });
  });
});

it("volto web 透传 --port/--gateway/--web-dir", async () => {
  await withEnvRestored(async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "volto-cli-"));
    const seen: WebServerOptions[] = [];
    const out: string[] = [];
    const code = await main(
      ["web", "--port", "0", "--gateway", "http://127.0.0.1:3999", "--web-dir", "/tmp/volto-out", "--config-dir", dir],
      {
        startWeb: async (opts) => {
          seen.push(opts);
          // `--port 0`: the real listener would report the assigned port.
          return fakeWebServer(6201);
        },
        stdout: (s) => out.push(s),
        waitForShutdown: async () => {},
      },
    );

    expect(code).toBe(0);
    expect(seen[0]).toMatchObject({
      port: 0,
      gateway: "http://127.0.0.1:3999",
      webRoot: "/tmp/volto-out",
    });
    // The printed URL names the port actually bound, not the requested 0.
    expect(out.join("")).toContain("listening on http://127.0.0.1:6201 -> http://127.0.0.1:3999");
    expect(out.join("")).toContain("Open: http://127.0.0.1:6201/");
  });
});

it("volto web 的非法 --gateway 直接以 2 退出且不启动服务器", async () => {
  await withEnvRestored(async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "volto-cli-"));
    const errors: string[] = [];
    const startWeb = vi.fn();
    const code = await main(["web", "--gateway", "not a url", "--config-dir", dir], {
      startWeb: startWeb as unknown as CliDeps["startWeb"],
      stdout: () => {},
      stderr: (s) => errors.push(s),
      waitForShutdown: async () => {},
    });
    expect(code).toBe(2);
    expect(startWeb).not.toHaveBeenCalled();
    expect(errors.join("")).toContain("Invalid --gateway");
  });
});

it("volto web 非 loopback --host 未加 --serve-remote 时拒绝启动", async () => {
  await withEnvRestored(async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "volto-cli-"));
    const errors: string[] = [];
    const startWeb = vi.fn();
    const code = await main(["web", "--host", "0.0.0.0", "--config-dir", dir], {
      startWeb: startWeb as unknown as CliDeps["startWeb"],
      stdout: () => {},
      stderr: (s) => errors.push(s),
      waitForShutdown: async () => {},
    });
    expect(code).toBe(1);
    expect(startWeb).not.toHaveBeenCalled();
    expect(errors.join("")).toContain("--serve-remote");
  });
});

it("volto web 加 --serve-remote 后允许非 loopback 绑定，且不再打印「不适用」", async () => {
  await withEnvRestored(async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "volto-cli-"));
    const seen: WebServerOptions[] = [];
    const out: string[] = [];
    const code = await main(
      ["web", "--host", "0.0.0.0", "--port", "0", "--serve-remote", "--config-dir", dir],
      {
        startWeb: async (opts) => {
          seen.push(opts);
          return fakeWebServer(6301);
        },
        stdout: (s) => out.push(s),
        waitForShutdown: async () => {},
      },
    );
    expect(code).toBe(0);
    expect(seen[0]).toMatchObject({ host: "0.0.0.0" });
    expect(out.join("")).toContain("listening on http://0.0.0.0:6301 -> ");
    expect(out.join("")).not.toContain("does not apply");
  });
});

it("--trust-proxy 接到 ServerOptions.trustProxy；缺省关闭", async () => {
  await withEnvRestored(async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "volto-cli-"));
    const seen: ServerOptions[] = [];
    const deps = (): CliDeps => ({
      startServer: async (opts) => {
        seen.push(opts);
        return fakeServer(opts.port ?? 0);
      },
      stdout: () => {},
      openBrowser: () => {},
      waitForShutdown: async () => {},
    });
    expect(await main(["--trust-proxy", "--no-open", "--config-dir", dir], deps())).toBe(0);
    expect(await main(["--no-open", "--config-dir", dir], deps())).toBe(0);
    expect(seen[0]?.trustProxy).toBe(true);
    expect(seen[1]?.trustProxy).toBe(false);
  });
});

it("VOLTO_CORS_ORIGINS 用逗号拆成白名单并传给 createServer", async () => {
  const previous = process.env["VOLTO_CORS_ORIGINS"];
  try {
    process.env["VOLTO_CORS_ORIGINS"] = " https://a.example , https://b.example ,, ";
    await withEnvRestored(async () => {
      const dir = await mkdtemp(path.join(tmpdir(), "volto-cli-"));
      const seen: ServerOptions[] = [];
      expect(
        await main(["--no-open", "--config-dir", dir], {
          startServer: async (opts) => {
            seen.push(opts);
            return fakeServer(opts.port ?? 0);
          },
          stdout: () => {},
          openBrowser: () => {},
          waitForShutdown: async () => {},
        }),
      ).toBe(0);
      expect(seen[0]?.corsOrigins).toEqual(["https://a.example", "https://b.example"]);
    });
  } finally {
    if (previous === undefined) delete process.env["VOLTO_CORS_ORIGINS"];
    else process.env["VOLTO_CORS_ORIGINS"] = previous;
  }
});
