import { createServer } from "node:http";

export interface BrowserFixture {
  url: string;
  close(): Promise<void>;
}

const LOGIN_PAGE = `<!doctype html>
<html><head><title>Sign in</title></head>
<body>
  <h1>Sign in</h1>
  <form id="login">
    <label for="email">Email</label>
    <input id="email" name="email" />
    <label for="password">Password</label>
    <input id="password" name="password" type="password" />
    <button type="submit">Sign in</button>
  </form>
  <script>
    document.querySelector("#login").addEventListener("submit", async (event) => {
      event.preventDefault();
      const response = await fetch("/api/login", { method: "POST" });
      if (response.ok) {
        window.location.href = "/dashboard";
        return;
      }
      const alert = document.createElement("p");
      alert.setAttribute("role", "alert");
      alert.textContent = "Invalid credentials";
      document.body.appendChild(alert);
    });
  </script>
</body></html>`;

const LOGIN_OK_PAGE = `<!doctype html>
<html><head><title>Sign in (ok)</title></head>
<body>
  <h1>Sign in</h1>
  <form id="login">
    <label for="email">Email</label>
    <input id="email" name="email" />
    <label for="password">Password</label>
    <input id="password" name="password" type="password" />
    <button type="submit">Sign in</button>
  </form>
  <script>
    document.querySelector("#login").addEventListener("submit", async (event) => {
      event.preventDefault();
      const response = await fetch("/api/login-ok", { method: "POST" });
      if (response.ok) {
        window.location.href = "/dashboard";
        return;
      }
      document.body.innerHTML = '<p role="alert">Invalid credentials</p>';
    });
  </script>
</body></html>`;

const CONSOLE_PAGE = `<!doctype html>
<html><head><title>Console</title></head>
<body><h1>Console</h1><script>console.error("fixture boom")</script></body></html>`;

const DENIED_PAGE = `<!doctype html>
<html><head><title>Denied</title></head>
<body><h1>Denied</h1><a href="http://169.254.169.254/latest/meta-data">metadata</a></body></html>`;

function escapeHtml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
}

/** A tiny local app used by the opt-in browser host e2e test. */
export async function startBrowserFixture(): Promise<BrowserFixture> {
  const server = createServer((req, res) => {
    const url = req.url ?? "/";
    if (url === "/login") {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(LOGIN_PAGE);
      return;
    }
    if (url === "/login-ok") {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(LOGIN_OK_PAGE);
      return;
    }
    if (url === "/dashboard") {
      const authed = (req.headers.cookie ?? "").includes("session=ok");
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(
        `<!doctype html><html><head><title>${authed ? "Dashboard" : "Login required"}</title></head><body><h1>${authed ? "Dashboard" : "Login required"}</h1></body></html>`,
      );
      return;
    }
    if (url === "/console") {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(CONSOLE_PAGE);
      return;
    }
    if (url.startsWith("/link")) {
      const parsed = new URL(url, "http://fixture.invalid");
      const to = parsed.searchParams.get("to") ?? "/";
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(
        `<!doctype html><html><head><title>Link</title></head><body><a href="${escapeHtml(to)}" target="_blank">open</a></body></html>`,
      );
      return;
    }
    if (url === "/denied") {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(DENIED_PAGE);
      return;
    }
    if (url === "/api/login") {
      res.writeHead(500, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "invalid credentials" }));
      return;
    }
    if (url === "/api/login-ok") {
      res.writeHead(200, {
        "content-type": "application/json",
        "set-cookie": "session=ok; Path=/; HttpOnly",
      });
      res.end(JSON.stringify({ ok: true }));
      return;
    }
    res.writeHead(404, { "content-type": "text/plain" });
    res.end("not found");
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    throw new Error("fixture server did not bind a TCP port");
  }
  return {
    url: `http://127.0.0.1:${address.port}`,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error === undefined ? resolve() : reject(error)));
      }),
  };
}