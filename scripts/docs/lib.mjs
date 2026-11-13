/**
 * Shared plumbing for the user-docs toolchain (scripts/docs/*.mjs).
 *
 * Two responsibilities:
 * 1. Surface extraction — the "user-visible surface" of the codebase, hashed
 *    so a change that nobody documented fails CI (see docs/user/WRITING.md).
 * 2. Page rendering — the generated reference pages are pure functions of a
 *    surface + a notes JSON file, so `docs:check` can detect hand edits by
 *    re-rendering.
 *
 * Extraction is regex-based on purpose: it only has to be stable enough to
 * notice that something changed, and an over-trigger (asking for a review
 * when nothing user-visible moved) costs one `docs:ack`, while a miss costs
 * a silently stale page.
 */

import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));
export const DOCS_DIR = path.join(ROOT, "docs/user");
export const META_DIR = path.join(DOCS_DIR, ".meta");

// ──────────────────────────────────────────────
// fs helpers
// ──────────────────────────────────────────────

export function walk(dir, filter = () => true) {
  if (!fs.existsSync(dir)) return [];
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
      out.push(...walk(full, filter));
    } else if (filter(full)) {
      out.push(full);
    }
  }
  return out;
}

export function readText(file) {
  return fs.readFileSync(file, "utf8");
}

export function readJson(file, fallback) {
  if (!fs.existsSync(file)) return fallback;
  return JSON.parse(readText(file));
}

export function writeText(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
}

export function relPath(file) {
  return path.relative(ROOT, file).split(path.sep).join("/");
}

export function sha256(text) {
  return createHash("sha256").update(text).digest("hex");
}

/** Hash a name list order-insensitively, so renames and moves are the only signal. */
export function hashNames(names) {
  return sha256([...names].sort().join("\n"));
}

// ──────────────────────────────────────────────
// markdown helpers
// ──────────────────────────────────────────────

const FRONT_MATTER = /^---\r?\n([\s\S]*?)\r?\n---\r?\n/;

/** Minimal YAML subset: scalars, booleans, and `- item` lists. No nesting beyond one level. */
export function parseFrontMatter(text) {
  const match = FRONT_MATTER.exec(text);
  if (!match) return { data: null, body: text };
  const data = {};
  let currentKey = null;
  for (const rawLine of match[1].split(/\r?\n/)) {
    if (!rawLine.trim() || rawLine.trim().startsWith("#")) continue;
    const listItem = /^\s*-\s+(.*)$/.exec(rawLine);
    if (listItem && currentKey) {
      data[currentKey] ??= [];
      data[currentKey].push(unquote(listItem[1]));
      continue;
    }
    const pair = /^([A-Za-z_][\w-]*):\s*(.*)$/.exec(rawLine);
    if (!pair) continue;
    currentKey = pair[1];
    const value = pair[2].trim();
    if (value === "") {
      data[currentKey] = [];
    } else if (value === "true" || value === "false") {
      data[currentKey] = value === "true";
    } else {
      data[currentKey] = unquote(value);
    }
  }
  return { data, body: text.slice(match[0].length) };
}

function unquote(value) {
  const trimmed = value.trim();
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

/** Strip fenced code blocks so heading/link scanning never parses examples. */
export function stripFences(markdown) {
  const lines = markdown.split(/\r?\n/);
  const kept = [];
  let inFence = false;
  let fenceToken = "";
  for (const line of lines) {
    const open = /^\s*(```+|~~~+)/.exec(line);
    if (open) {
      if (!inFence) {
        inFence = true;
        fenceToken = open[1][0];
      } else if (open[1][0] === fenceToken) {
        inFence = false;
      }
      continue;
    }
    if (!inFence) kept.push(line);
  }
  return kept.join("\n");
}

export function headings(markdown) {
  return stripFences(markdown)
    .split(/\r?\n/)
    .map((line) => /^\s{0,3}(#{1,6})\s+(.*)$/.exec(line))
    .filter(Boolean)
    .map((match) => ({ level: match[1].length, text: match[2].trim() }));
}

/** GitHub-compatible enough: lowercase, drop punctuation, spaces to hyphens. */
export function slugify(text) {
  return text
    .toLowerCase()
    .replace(/[`*~]/g, "")
    .replace(/<[^>]*>/g, "")
    .replace(/[^\p{L}\p{N}\s_-]/gu, "")
    .trim()
    .replace(/\s+/g, "-");
}

export function codeFences(markdown, language) {
  const fences = [];
  const re = /^\s*```([\w-]*)[^\n]*\n([\s\S]*?)^\s*```/gm;
  let match;
  while ((match = re.exec(markdown))) {
    if (!language || match[1] === language) fences.push(match[2]);
  }
  return fences;
}

// ──────────────────────────────────────────────
// surface extraction
// ──────────────────────────────────────────────

/** Tool packages declare one `defineTool({ name: "..." })` per tool; imports may alias the helper. */
export function extractTools() {
  const tools = [];
  const packages = fs.existsSync(path.join(ROOT, "packages/tools"))
    ? fs.readdirSync(path.join(ROOT, "packages/tools"))
    : [];
  for (const pkg of packages) {
    const srcDir = path.join(ROOT, "packages/tools", pkg, "src");
    const files = walk(srcDir, (file) => file.endsWith(".ts") && !file.includes("__tests__"));
    for (const file of files) {
      const source = readText(file);
      const aliases = new Set(["defineTool"]);
      for (const im of source.matchAll(/import\s*\{([^}]*)\}\s*from\s*"[^"]*tools-common"/g)) {
        for (const part of im[1].split(",")) {
          const alias = /^defineTool\s+as\s+(\w+)$/.exec(part.trim());
          if (alias) aliases.add(alias[1]);
        }
      }
      const splitter = new RegExp(`\\b(?:${[...aliases].join("|")})\\(`, "g");
      for (const chunk of source.split(splitter).slice(1)) {
        const name = /^\s*name:\s*"([a-z][a-z0-9_]+)"/m.exec(chunk);
        if (name) tools.push({ name: name[1], group: pkg, file: relPath(file) });
      }
    }
  }
  return [...new Map(tools.map((tool) => [tool.name, tool])).values()].sort((a, b) =>
    a.name < b.name ? -1 : 1,
  );
}

/**
 * Gateway routes, harvested from the shapes the handlers actually use:
 *   `req.method === "GET" && url.pathname === "/events"`
 *   `url.pathname.startsWith("/sessions/")`     (method checked separately)
 *
 * Regex-matched routes (`url.pathname.match(/^\/sessions\/([^/]+)\/plan$/)`)
 * are not extracted here; their `:param` forms are supplied by
 * gateway-notes.json, and the notes check keeps them honest against this file.
 */
export function extractHttpRoutes() {
  const file = path.join(ROOT, "apps/gateway/src/server.ts");
  if (!fs.existsSync(file)) return [];
  const source = readText(file);
  const routes = new Set();
  const methodRe =
    /req\.method === "(GET|POST|PUT|DELETE|PATCH)"[^\n]*?url\.pathname\s*(?:===|\.\s*startsWith\s*\()\s*"([^"]+)"/g;
  for (const match of source.matchAll(methodRe)) {
    const wildcard = match[0].includes("startsWith") ? "*" : "";
    routes.add(`${match[1]} ${match[2]}${wildcard}`);
  }
  const coveredPaths = new Set([...routes].map((route) => route.split(" ")[1]));
  const prefixRe = /url\.pathname\s*\.\s*startsWith\s*\(\s*"([^"]+)"/g;
  for (const match of source.matchAll(prefixRe)) {
    const routePath = `${match[1]}*`;
    if (!coveredPaths.has(routePath)) routes.add(`* ${routePath}`);
  }
  const exactRe = /url\.pathname\s*===\s*"([^"]+)"/g;
  for (const match of source.matchAll(exactRe)) {
    if (!coveredPaths.has(match[1])) routes.add(`* ${match[1]}`);
  }
  return [...routes].sort();
}

/** Section names of `~/.volto/config.json`, read from the store's legacy-file map. */
export function extractConfigSections() {
  const file = path.join(ROOT, "apps/gateway/src/config/store.ts");
  if (!fs.existsSync(file)) return [];
  const source = readText(file);
  const block = /LEGACY_FILES\s*=\s*\{([\s\S]*?)\}\s*as const/.exec(source);
  const sections = block
    ? [...block[1].matchAll(/^\s*(\w+):\s*"/gm)].map((match) => match[1])
    : [];
  return [...new Set([...sections, "sidebar"])].sort();
}

/** Keys each config validator accepts, harvested from its `*_KEYS` constant arrays. */
export function extractConfigKeys() {
  const dir = path.join(ROOT, "apps/gateway/src/config");
  const keys = {};
  for (const file of walk(dir, (entry) => entry.endsWith(".ts") && !entry.includes("__tests__"))) {
    const section = path.basename(file, ".ts");
    const source = readText(file);
    for (const match of source.matchAll(/const\s+\w*_KEYS\s*=\s*\[([\s\S]*?)\]\s*as const/g)) {
      for (const literal of match[1].matchAll(/"([^"]+)"/g)) {
        (keys[section] ??= new Set()).add(literal[1]);
      }
    }
  }
  return Object.fromEntries(
    Object.entries(keys).map(([section, set]) => [section, [...set].sort()]),
  );
}

/**
 * Public exports of the SDK barrel, with their value/type kind.
 *
 * Comment lines inside an `export { ... }` block are stripped before parsing:
 * the barrel groups its re-exports with `// M8: …` markers, and a split on
 * commas would otherwise turn a marker into a fake export name.
 */
export function extractSdkExportDetail() {
  const file = path.join(ROOT, "packages/sdk/src/index.ts");
  if (!fs.existsSync(file)) return [];
  const source = readText(file);
  const exports = new Map();
  for (const match of source.matchAll(/export\s+(type\s+)?\{([\s\S]*?)\}\s*from/g)) {
    const blockKind = match[1] ? "type" : "value";
    const block = match[2]
      .replace(/\/\/[^\n]*/g, "")
      .replace(/\/\*[\s\S]*?\*\//g, "");
    for (const part of block.split(",")) {
      const trimmed = part.trim();
      if (!trimmed) continue;
      const inlineType = /^type\s+/.test(trimmed);
      const cleaned = trimmed.replace(/^type\s+/, "");
      const aliased = /^(\w+)\s+as\s+(\w+)$/.exec(cleaned);
      const name = aliased ? aliased[2] : cleaned;
      if (!/^\w+$/.test(name)) continue;
      exports.set(name, blockKind === "type" || inlineType ? "type" : "value");
    }
  }
  // `export * as ns from "./x.js"` — a namespace value export, not a name list.
  for (const match of source.matchAll(/export\s+\*\s+as\s+(\w+)\s+from/g)) {
    exports.set(match[1], "value");
  }
  return [...exports.entries()]
    .map(([name, kind]) => ({ name, kind }))
    .sort((a, b) => (a.name < b.name ? -1 : 1));
}

/** Public names exported from the SDK barrel. */
export function extractSdkExports() {
  return extractSdkExportDetail().map((entry) => entry.name);
}

/**
 * Signature-level fingerprint of the SDK's public types. Name-level export
 * tracking cannot see an options field being renamed, added, or retyped, and
 * that is exactly what an integrator's page documents. Comments and
 * whitespace are stripped first so formatting does not move the hash.
 */
export function sdkTypesDigest() {
  const file = path.join(ROOT, "packages/sdk/dist/index.d.ts");
  if (!fs.existsSync(file)) {
    return { missing: true, hash: null, names: [] };
  }
  const stripped = readText(file)
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "")
    .replace(/\s+/g, " ")
    .trim();
  return { missing: false, hash: sha256(stripped), names: [] };
}

/** Top-level keys of the zh message catalogs — the copy surface the UI is built from. */
export function extractUiCatalog() {
  const dir = path.join(ROOT, "apps/web/messages/zh");
  const names = [];
  for (const file of walk(dir, (entry) => entry.endsWith(".json"))) {
    const catalog = readJson(file, {});
    const prefix = path.basename(file, ".json");
    for (const key of Object.keys(catalog)) names.push(`${prefix}:${key}`);
  }
  return names.sort();
}

/** All surfaces, each with a hash and the names that produced it. */
export function computeSurfaces() {
  const tools = extractTools();
  const sdkTypes = sdkTypesDigest();
  const configSections = extractConfigSections();
  const configKeys = extractConfigKeys();
  const sections = {
    tools: { names: tools.map((tool) => tool.name), extra: tools },
    httpRoutes: { names: extractHttpRoutes(), extra: [] },
    config: {
      names: [
        ...configSections.map((section) => `section:${section}`),
        ...Object.entries(configKeys).flatMap(([section, keys]) =>
          keys.map((key) => `${section}.${key}`),
        ),
      ].sort(),
      extra: [],
    },
    sdkExports: { names: extractSdkExports(), extra: [] },
    sdkTypes: { names: sdkTypes.names, extra: [], hash: sdkTypes.hash, missing: sdkTypes.missing },
    uiCatalog: { names: extractUiCatalog(), extra: [] },
  };
  const out = {};
  for (const [name, value] of Object.entries(sections)) {
    out[name] = {
      hash: value.hash ?? hashNames(value.names),
      names: value.names,
      ...(value.missing ? { missing: true } : {}),
    };
  }
  return { version: 1, sections: out, toolDetail: tools };
}

export function surfaceFilePath() {
  return path.join(META_DIR, "surface.json");
}

export function reviewedFilePath() {
  return path.join(META_DIR, "reviewed.json");
}

export function routingFilePath() {
  return path.join(META_DIR, "routing.json");
}

// ──────────────────────────────────────────────
// page rendering (generated pages)
// ──────────────────────────────────────────────

export const GENERATED_HEADER =
  "<!-- GENERATED FILE — do not edit by hand. Run `pnpm docs:gen`; hand edits are reported as drift by `pnpm docs:check`. -->";

/** Pick a localized value from the notes; plain strings are accepted during migration. */
function loc(value, locale) {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value[locale] ?? value.en ?? value.zh ?? "";
  }
  return value ?? "";
}

function table(headers, rows) {
  // Notes may contain a literal `|` (a TypeScript union, for example); escape it so the
  // Markdown table does not gain a column.
  const cell = (value) => String(value).replace(/\|/g, "\\|");
  const head = `| ${headers.map(cell).join(" | ")} |`;
  const sep = `| ${headers.map(() => "---").join(" | ")} |`;
  const body = rows.map((row) => `| ${row.map(cell).join(" | ")} |`);
  return [head, sep, ...body].join("\n");
}

function frontMatter(fields) {
  const lines = ["---"];
  for (const [key, value] of Object.entries(fields)) {
    if (Array.isArray(value)) {
      lines.push(`${key}:`);
      for (const item of value) lines.push(`  - ${item}`);
    } else {
      lines.push(`${key}: ${value}`);
    }
  }
  lines.push("---");
  return lines.join("\n");
}

const VERIFIED = "2026-11-11";

/** Static copy for the generated pages, one entry per locale. */
const T = {
  tools: {
    en: {
      title: "Tool reference",
      intro:
        "Every tool the agent can call. **Tool visibility does not mean approval** — permission modes and approval cards are covered in [Permissions and approvals](../guides/permissions-and-approvals.md).",
      headers: ["Tool", "Group", "Purpose"],
      count: (n) =>
        `${n} tools in total. Groups map to \`packages/tools/<group>\`; tools in the same group share a permission capability.`,
      footer:
        "> Generated by `pnpm docs:gen`: the purpose text comes from `docs/user/reference/tool-notes.json`; a new tool without an entry makes `pnpm docs:check` fail.",
      missing: "·missing·",
    },
    zh: {
      title: "工具参考",
      intro:
        "agent 能调用的每一个工具。**工具可见不等于被放行**——三档权限与审批卡见 [权限与审批](../guides/permissions-and-approvals.md)。",
      headers: ["工具", "分组", "用途"],
      count: (n) => `共 ${n} 个。分组对应 \`packages/tools/<分组>\`；同一分组的工具共享一组权限能力。`,
      footer:
        "> 这张表由 `pnpm docs:gen` 生成：中文用途来自 `docs/user/reference/tool-notes.json`，新增工具缺条目会让 `pnpm docs:check` 失败。",
      missing: "·待补·",
    },
  },
  config: {
    en: {
      title: "Configuration reference",
      intro:
        "All user-level configuration lives in `~/.volto/config.json` (`VOLTO_CONFIG_DIR` changes the directory).",
      shape:
        "Sections have different shapes: most are objects (`preferences`, `providers`, `permissions`, `egress`, `lsp`, `hooks`, `sidebar`); `projects` and `routingTiers` are arrays. Validation strictness also differs:",
      strict:
        "- `egress` / `permissions` / `lsp` / `hooks`: an unknown key makes the gateway **refuse to start** (a typo is an explicit error; that is intentional).",
      loose:
        "- `preferences` / `sidebar`: unknown keys are ignored and invalid values fall back to defaults.",
      top:
        "- **A misspelled top-level section name does not error**: that part of the config simply has no effect. After editing, confirm it took effect in the UI or through an API.",
      guide:
        "How to edit it, when it takes effect, and how to recover from a bad edit are covered in [Permissions and approvals](../guides/permissions-and-approvals.md) and [Models and providers](../guides/models-and-providers.md); this page only lists fields.",
      headers: ["Field", "Description"],
      runtimeOnly: "_This section is maintained by the gateway at runtime; it normally needs no manual edit._",
      missing: "·missing·",
    },
    zh: {
      title: "配置文件参考",
      intro: "所有用户级配置集中在 `~/.volto/config.json`（可用 `VOLTO_CONFIG_DIR` 改目录）。",
      shape:
        "分区形状不一：多数是对象（`preferences`、`providers`、`permissions`、`egress`、`lsp`、`hooks`、`sidebar`），`projects` 与 `routingTiers` 是数组。校验强度也不一：",
      strict: "- `egress` / `permissions` / `lsp` / `hooks`：未知键会让网关**拒绝启动**（拼错等于明确报错，这是有意的）。",
      loose: "- `preferences` / `sidebar`：未知键被忽略，非法值回落到默认。",
      top: "- **顶层分区名写错不会报错**：那一段配置只是不生效。改完请用界面或接口确认真的生效了。",
      guide:
        "怎么改、什么时候生效、改坏了怎么办，见 [权限与审批](../guides/permissions-and-approvals.md) 与 [模型与供应商](../guides/models-and-providers.md)；本文只列字段。",
      headers: ["字段", "说明"],
      runtimeOnly: "_该分区由网关在运行时维护，通常不需要手改。_",
      missing: "·待补·",
    },
  },
  gateway: {
    en: {
      title: "Gateway HTTP API",
      intro:
        "The gateway (`apps/gateway`) is the official host: it wires the SDK to models, the sandbox and the filesystem, then exposes everything over HTTP + SSE to the Web UI and the desktop app.",
      contract:
        "**Public contract** means endpoints a custom host or an alternative frontend can rely on: paths, methods, authentication and response shapes stay backward compatible. You can also skip the gateway entirely and call `@voltojs/sdk` directly (see [Embed the agent](../tutorial/01-embed-agent.md)).",
      publicHeading: "## Public contract",
      internalHeading: "## Internal routes (follow the UI, no compatibility promise)",
      publicHeaders: ["Method", "Path", "Purpose"],
      internalHeaders: ["Method", "Path", "Category"],
      authHeading: "## Authentication and transport",
      auth1:
        "- Everything except `/health` requires authentication: send `Authorization: Bearer <launchToken>`, or visit any path with `?token=<launchToken>` — the gateway exchanges it for a cookie and redirects to the clean path, so the token does not stay in the address bar.",
      auth2:
        "- Request and response bodies are JSON; the streamed events of a turn come from the `GET /events` SSE connection (the client lives in `@voltojs/sdk/sse`).",
      footer:
        "> Generated by `pnpm docs:gen` from the routes in `server.ts`; purposes come from `docs/user/reference/gateway-notes.json`. Adding or removing a route makes `pnpm docs:check` fail until the notes are updated.",
      internalLabel: "internal",
      missing: "·missing·",
    },
    zh: {
      title: "网关 HTTP 接口",
      intro:
        "网关（`apps/gateway`）是官方宿主：它把 SDK 与模型、沙箱、文件系统接线，再用 HTTP + SSE 暴露给 Web UI 与桌面端。",
      contract:
        "**对外契约**指自建宿主或替代前端可以直接依赖的接口：路径、方法、鉴权方式与响应形状保持向后兼容。也可以完全不用网关，直接调 `@voltojs/sdk`（见 [接入 SDK](../tutorial/01-embed-agent.md)）。",
      publicHeading: "## 对外契约",
      internalHeading: "## 内部接口（跟随 UI 变动，不承诺兼容）",
      publicHeaders: ["方法", "路径", "用途"],
      internalHeaders: ["方法", "路径", "归类"],
      authHeading: "## 鉴权与传输",
      auth1:
        "- 除 `/health` 外都要鉴权：带 `Authorization: Bearer <launchToken>`，或先访问任意路径并在查询串上带 `?token=<launchToken>`——网关会换取一个 cookie 并重定向回干净路径，token 不再留在地址栏。",
      auth2:
        "- 请求与响应体为 JSON；一轮对话的流式事件走 `GET /events` 的 SSE 长连接（`@voltojs/sdk/sse` 有对应客户端）。",
      footer:
        "> 这张表由 `pnpm docs:gen` 从 `server.ts` 抽取路由，用途来自 `docs/user/reference/gateway-notes.json`。新增或删除路由会让 `pnpm docs:check` 失败，直到 notes 同步。",
      internalLabel: "内部",
      missing: "·待补·",
    },
  },
  sdk: {
    en: {
      title: "SDK exports",
      intro: "The public exports of `@voltojs/sdk`. Per-item semantics are in [SDK guide](./sdk-api.md).",
      values: (n) => `## Values (functions / constants / classes) · ${n}`,
      types: (n) => `## Types · ${n}`,
      headers: ["Export"],
      footer:
        "> Generated by `pnpm docs:gen`. `@voltojs/sdk` and the other packages are released to the public npm registry (`npm i @voltojs/sdk`, see [Publishing and installing](../guides/publishing.md)); **Node ≥ 22** is required and **only ESM entry points are provided**: `import` and dynamic `import()` work, `require()` cannot load it directly.",
    },
    zh: {
      title: "SDK 导出清单",
      intro: "`@voltojs/sdk` 的公开导出。逐项语义见 [SDK 导读](./sdk-api.md)。",
      values: (n) => `## 值（函数 / 常量 / 类）· ${n} 个`,
      types: (n) => `## 类型 · ${n} 个`,
      headers: ["导出"],
      footer:
        "> 这张表由 `pnpm docs:gen` 生成。`@voltojs/sdk` 与其他包同版本发布到 npm 公共 registry（`npm i @voltojs/sdk`，见 [发布与安装](../guides/publishing.md)），要求 **Node ≥ 22**，**只提供 ESM 入口**：`import` 或动态 `import()` 可用，`require()` 不能直接加载它。",
    },
  },
};

export function buildToolsPage(surfaces, notes, locale = "en") {
  const t = T.tools[locale] ?? T.tools.en;
  const rows = surfaces.toolDetail.map((tool) => [
    tool.name,
    tool.group,
    loc(notes[tool.name], locale) || t.missing,
  ]);
  return [
    frontMatter({
      title: t.title,
      type: "reference",
      generated: true,
      source: ["packages/tools/*/src"],
      verified: VERIFIED,
    }),
    GENERATED_HEADER,
    "",
    `# ${t.title}`,
    "",
    t.intro,
    "",
    table(t.headers, rows),
    "",
    t.count(surfaces.toolDetail.length),
    "",
    t.footer,
    "",
  ].join("\n");
}

export function buildConfigPage(sections, keys, notes, locale = "en") {
  const t = T.config[locale] ?? T.config.en;
  const blocks = [];
  for (const section of sections) {
    const note = notes[section] ?? {};
    const fields = note.fields ?? {};
    const codeKeys = keys[section] ?? [];
    const names = [...new Set([...Object.keys(fields), ...codeKeys])].sort();
    const summary = loc(note.summary, locale);
    blocks.push(`## \`${section}\``);
    blocks.push("");
    if (summary) blocks.push(summary, "");
    if (names.length === 0) {
      if (!summary) blocks.push(t.runtimeOnly, "");
      blocks.push("");
      continue;
    }
    blocks.push(
      table(
        t.headers,
        names.map((name) => [`\`${name}\``, loc(fields[name], locale) || t.missing]),
      ),
    );
    blocks.push("");
  }
  return [
    frontMatter({
      title: t.title,
      type: "reference",
      generated: true,
      source: ["apps/gateway/src/config/*.ts"],
      verified: VERIFIED,
    }),
    GENERATED_HEADER,
    "",
    `# ${t.title}`,
    "",
    t.intro,
    "",
    t.shape,
    "",
    t.strict,
    t.loose,
    t.top,
    "",
    t.guide,
    "",
    ...blocks,
  ].join("\n");
}

export function buildGatewayPage(routes, notes, locale = "en") {
  const t = T.gateway[locale] ?? T.gateway.en;
  const publicRoutes = (notes.public ?? []).map((entry) => ({
    key: `${entry.method} ${entry.path}`,
    ...entry,
  }));
  const internal = new Set(notes.internal ?? []);
  const publicKeys = new Set(publicRoutes.map((entry) => entry.key));
  const publicRows = publicRoutes
    .sort((a, b) => (a.path === b.path ? a.method.localeCompare(b.method) : a.path.localeCompare(b.path)))
    .map((entry) => [`\`${entry.method}\``, `\`${entry.path}\``, loc(entry.note, locale)]);
  const documentedPaths = new Set(
    [...publicKeys].map((key) => key.split(" ").slice(1).join(" ").replace(/\*$/, "")),
  );
  const internalRows = routes
    .filter((route) => !publicKeys.has(route))
    .filter((route) => !documentedPaths.has(route.split(" ")[1].replace(/\*$/, "")))
    .map((route) => {
      const [method, routePath] = route.split(" ");
      return [`\`${method}\``, `\`${routePath}\``, internal.has(routePath) ? t.internalLabel : t.missing];
    });
  return [
    frontMatter({
      title: t.title,
      type: "reference",
      generated: true,
      source: ["apps/gateway/src/server.ts"],
      verified: VERIFIED,
    }),
    GENERATED_HEADER,
    "",
    `# ${t.title}`,
    "",
    t.intro,
    "",
    t.contract,
    "",
    t.publicHeading,
    "",
    table(t.publicHeaders, publicRows),
    "",
    t.internalHeading,
    "",
    table(t.internalHeaders, internalRows),
    "",
    t.authHeading,
    "",
    t.auth1,
    t.auth2,
    "",
    t.footer,
    "",
  ].join("\n");
}

export function buildSdkExportsPage(detail, locale = "en") {
  const t = T.sdk[locale] ?? T.sdk.en;
  const values = detail.filter((entry) => entry.kind === "value");
  const types = detail.filter((entry) => entry.kind === "type");
  const rows = (list) => list.map((entry) => [`\`${entry.name}\``]);
  return [
    frontMatter({
      title: t.title,
      type: "reference",
      generated: true,
      source: ["packages/sdk/src/index.ts"],
      verified: VERIFIED,
    }),
    GENERATED_HEADER,
    "",
    `# ${t.title}`,
    "",
    t.intro,
    "",
    t.values(values.length),
    "",
    table(t.headers, rows(values)),
    "",
    t.types(types.length),
    "",
    table(t.headers, rows(types)),
    "",
    t.footer,
    "",
  ].join("\n");
}

export function generatedPages() {
  return [
    {
      rel: "using/reference/tools.md",
      notes: "reference/tool-notes.json",
      build: (surfaces, notes, locale) => buildToolsPage(surfaces, notes, locale),
    },
    {
      rel: "using/reference/config.md",
      notes: "reference/config-sections.json",
      build: (surfaces, notes, locale) =>
        buildConfigPage(extractConfigSections(), extractConfigKeys(), notes, locale),
    },
    {
      rel: "integrating/reference/gateway-api.md",
      notes: "reference/gateway-notes.json",
      build: (_surfaces, notes, locale) => buildGatewayPage(extractHttpRoutes(), notes, locale),
    },
    {
      rel: "integrating/reference/sdk-exports.md",
      notes: null,
      build: (_surfaces, _notes, locale) => buildSdkExportsPage(extractSdkExportDetail(), locale),
    },
  ];
}

/** Notes are loaded once and passed through, so renderers stay pure. */
export function loadNotes(rel) {
  return readJson(path.join(DOCS_DIR, rel), {});
}