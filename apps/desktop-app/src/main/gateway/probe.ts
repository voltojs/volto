/**
 * Decide whether a gateway is usable before the content view is pointed at it.
 *
 * Three checks, cheapest first: liveness (`/health`, public), the exported web
 * build (a 503 from `/` means the API works but there is no UI to show), and
 * credentials (`/gateway-info` requires the token). Each failure has its own
 * sentence, because "cannot connect" alone does not tell the user what to fix.
 */

const DEFAULT_TIMEOUT_MS = 4_000;

export type ProbeResult =
  | { ok: true; version?: string; mode?: "local" | "remote" }
  | { ok: false; error: string };

export interface ProbeOptions {
  fetch?: typeof fetch;
  timeoutMs?: number;
}

function describeError(error: unknown): string {
  if (error instanceof Error) {
    if (error.name === "TimeoutError" || error.name === "AbortError") return "请求超时";
    return error.message === "" ? String(error) : error.message;
  }
  return String(error);
}

function timeoutSignal(timeoutMs: number): AbortSignal {
  return AbortSignal.timeout(timeoutMs);
}

/** Discard a response body we do not use, so the socket can be reused. */
function drain(response: Response): void {
  void response.body?.cancel().catch(() => undefined);
}

export async function probeGateway(
  url: string,
  token: string | undefined,
  options: ProbeOptions = {},
): Promise<ProbeResult> {
  const fetchFn = options.fetch ?? fetch;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const base = url.replace(/\/+$/, "");

  let health: Response;
  try {
    health = await fetchFn(`${base}/health`, {
      signal: timeoutSignal(timeoutMs),
      headers: { "cache-control": "no-store" },
    });
  } catch (error) {
    return { ok: false, error: `无法连接网关：${describeError(error)}` };
  }
  drain(health);
  if (health.status !== 200) {
    return { ok: false, error: `无法连接网关：HTTP ${health.status}` };
  }

  try {
    const root = await fetchFn(`${base}/`, {
      redirect: "manual",
      signal: timeoutSignal(timeoutMs),
      headers: { "cache-control": "no-store" },
    });
    drain(root);
    if (root.status === 503) {
      return { ok: false, error: "网关没有可用的 Web UI（缺少 web 构建）" };
    }
  } catch {
    // Reachability already proved; the UI check is advisory.
  }

  let info: Response;
  try {
    info = await fetchFn(`${base}/gateway-info`, {
      signal: timeoutSignal(timeoutMs),
      headers: {
        ...(token !== undefined && token !== "" ? { authorization: `Bearer ${token}` } : {}),
        "cache-control": "no-store",
      },
    });
  } catch (error) {
    return { ok: false, error: `无法连接网关：${describeError(error)}` };
  }
  if (info.status === 401 || info.status === 403) {
    drain(info);
    return {
      ok: false,
      error:
        token === undefined || token === ""
          ? "需要访问令牌：在网关机器上运行 volto token 获取"
          : "访问令牌无效或已过期",
    };
  }
  if (info.status !== 200) {
    drain(info);
    return { ok: true };
  }
  const body = (await info.json().catch(() => undefined)) as
    | { version?: unknown; mode?: unknown }
    | undefined;
  const version = typeof body?.version === "string" ? body.version : undefined;
  const mode = body?.mode === "local" || body?.mode === "remote" ? body.mode : undefined;
  return {
    ok: true,
    ...(version !== undefined ? { version } : {}),
    ...(mode !== undefined ? { mode } : {}),
  };
}