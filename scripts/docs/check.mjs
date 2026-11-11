/**
 * `pnpm docs:check` — the user-docs quality gate.
 *
 * Read-only by design: CI runs exactly this. Everything it can prove
 * mechanically is an error (stale generated pages, broken links, undocumented
 * tools, a surface change nobody acknowledged), and everything that needs
 * judgement is a warning (page too long, stale `verified` date, internal
 * jargon).
 */

import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import {
  DOCS_DIR,
  ROOT,
  codeFences,
  computeSurfaces,
  extractConfigKeys,
  extractConfigSections,
  extractHttpRoutes,
  extractTools,
  generatedPages,
  hashNames,
  headings,
  loadNotes,
  parseFrontMatter,
  readJson,
  readText,
  routingFilePath,
  slugify,
  stripFences,
  surfaceFilePath,
  walk,
} from "./lib.mjs";

const STRICT = process.argv.includes("--strict");
const problems = [];
const error = (where, message) => problems.push({ level: "error", where, message });
const warn = (where, message) => problems.push({ level: STRICT ? "error" : "warn", where, message });

const PAGE_TYPES = new Set(["tutorial", "guide", "reference", "concept"]);
const REQUIRED_KEYS = ["title", "type", "source", "generated", "verified"];
const JARGON = ["reducer", "port", "Effect", "capability", "ToolDefinition", "ModelPort", "EventSink", "SessionStore", "纯函数"];
const STALE_DAYS = 90;

// ──────────────────────────────────────────────
// Load pages
// ──────────────────────────────────────────────

const files = walk(DOCS_DIR, (file) => file.endsWith(".md"));
const pages = files.map((file) => {
  const text = readText(file);
  const rel = path.relative(DOCS_DIR, file).split(path.sep).join("/");
  const { data, body } = parseFrontMatter(text);
  return { file, rel, text, data, body };
});
const indexPages = new Set(["README.md", "WRITING.md"]);

// Repository paths (files AND directories), for `source:` glob validation.
// Directories count because a page may legitimately claim a whole component
// directory (`apps/web/components/settings`) rather than one file.
const repoPaths = new Set();
for (const name of fs.readdirSync(ROOT, { withFileTypes: true })) {
  if (name.isFile()) repoPaths.add(name.name);
}
for (const top of ["packages", "apps", "scripts", "docs"]) {
  const collect = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === "node_modules" || entry.name === "dist" || entry.name.startsWith(".")) continue;
      const full = path.join(dir, entry.name);
      repoPaths.add(path.relative(ROOT, full).split(path.sep).join("/"));
      if (entry.isDirectory()) collect(full);
    }
  };
  if (fs.existsSync(path.join(ROOT, top))) collect(path.join(ROOT, top));
}

function globToRegExp(pattern) {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*\*/g, "\u0000").replace(/\*/g, "[^/]*").replace(/\u0000/g, ".*");
  return new RegExp(`^${escaped}$`);
}

// ──────────────────────────────────────────────
// 1. front matter
// ──────────────────────────────────────────────

for (const page of pages) {
  if (indexPages.has(page.rel)) continue;
  if (!page.data) {
    error(page.rel, "缺少 front-matter（至少要有 title / type / source / generated / verified）");
    continue;
  }
  for (const key of REQUIRED_KEYS) {
    if (page.data[key] === undefined) error(page.rel, `front-matter 缺少 \`${key}\``);
  }
  if (page.data.type && !PAGE_TYPES.has(page.data.type)) {
    error(page.rel, `type 必须是 ${[...PAGE_TYPES].join(" / ")}，当前是 ${page.data.type}`);
  }
  if (page.data.verified && !/^\d{4}-\d{2}-\d{2}$/.test(page.data.verified)) {
    error(page.rel, `verified 必须是 YYYY-MM-DD，当前是 ${page.data.verified}`);
  }
  const sources = Array.isArray(page.data.source) ? page.data.source : [];
  if (sources.length === 0) error(page.rel, "source 至少要写一条实现路径");
  for (const source of sources) {
    const matcher = globToRegExp(source);
    const found =
      repoPaths.has(source) ||
      [...repoPaths].some((entry) => entry.startsWith(`${source}/`)) ||
      [...repoPaths].some((entry) => matcher.test(entry));
    if (!found) error(page.rel, `source 指向不存在的路径：${source}`);
  }
}

// ──────────────────────────────────────────────
// 2. links, anchors, images
// ──────────────────────────────────────────────

const headingsByFile = new Map();
for (const page of pages) {
  headingsByFile.set(
    page.file,
    new Set(headings(page.text).map((heading) => slugify(heading.text))),
  );
}

for (const page of pages) {
  const body = stripFences(page.text);
  for (const match of body.matchAll(/!?\[[^\]]*\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g)) {
    const target = match[1];
    if (/^(https?:|mailto:|#)/.test(target)) continue;
    const [linkPath, anchor] = target.split("#");
    const resolved = path.resolve(path.dirname(page.file), decodeURI(linkPath));
    if (!fs.existsSync(resolved)) {
      error(page.rel, `链接指向不存在的文件：${target}`);
      continue;
    }
    if (anchor && resolved.endsWith(".md")) {
      const slugs = headingsByFile.get(resolved);
      if (slugs && !slugs.has(slugify(decodeURI(anchor)))) {
        error(page.rel, `锚点不存在：${target}`);
      }
    }
  }
}

// ──────────────────────────────────────────────
// 3. generated pages are in sync with their inputs
// ──────────────────────────────────────────────

const surfaces = computeSurfaces();
for (const page of generatedPages()) {
  const target = path.join(DOCS_DIR, page.rel);
  const notes = page.notes ? loadNotes(page.notes) : {};
  const expected = page.build(surfaces, notes);
  const actual = fs.existsSync(target) ? readText(target) : "";
  if (expected !== actual) {
    error(page.rel, "生成页与输入不一致——运行 `pnpm docs:sync`（或改 notes JSON 后重新生成）");
  }
}

// ──────────────────────────────────────────────
// 4. notes coverage: every surface name has a human sentence
// ──────────────────────────────────────────────

const toolNotes = loadNotes("reference/tool-notes.json");
const tools = extractTools();
for (const tool of tools) {
  if (!toolNotes[tool.name]) error("docs/user/reference/tool-notes.json", `工具 \`${tool.name}\` 缺少中文说明`);
}
for (const name of Object.keys(toolNotes)) {
  if (!tools.some((tool) => tool.name === name)) {
    error("docs/user/reference/tool-notes.json", `\`${name}\` 已不存在，删掉这条说明`);
  }
}

const configNotes = loadNotes("reference/config-sections.json");
const codeSections = extractConfigSections();
const codeKeys = extractConfigKeys();
for (const section of codeSections) {
  if (!configNotes[section]) error("docs/user/reference/config-sections.json", `配置分区 \`${section}\` 缺少说明`);
}
for (const section of Object.keys(configNotes)) {
  if (!codeSections.includes(section)) {
    error("docs/user/reference/config-sections.json", `分区 \`${section}\` 在代码中已不存在`);
  }
  for (const key of codeKeys[section] ?? []) {
    if (!configNotes[section]?.fields?.[key]) {
      error("docs/user/reference/config-sections.json", `\`${section}.${key}\` 缺少字段说明`);
    }
  }
}

const gatewayNotes = loadNotes("reference/gateway-notes.json");
const serverSource = readText(path.join(ROOT, "apps/headless-server/src/server.ts"));
const publicKeys = new Set((gatewayNotes.public ?? []).map((entry) => `${entry.method} ${entry.path}`));
const internalPaths = new Set(gatewayNotes.internal ?? []);
const publicPaths = new Set(
  [...publicKeys].map((key) => key.split(" ").slice(1).join(" ")),
);
for (const route of extractHttpRoutes()) {
  const [method, routePath] = route.split(" ");
  // A "<any method> /path" row is covered when that path is documented for at
  // least one concrete method — the gateway checks the method inside the handler.
  const covered = method === "*" ? publicPaths.has(routePath) || internalPaths.has(routePath) : publicKeys.has(route) || internalPaths.has(routePath);
  if (!covered) {
    error(
      "docs/user/reference/gateway-notes.json",
      `路由 \`${route}\` 未归类——写进 public（附用途）或 internal`,
    );
  }
}
for (const entry of gatewayNotes.public ?? []) {
  // Param routes are matched by a regex or a prefix, so check the static part:
  // `GET /sessions/*` → `"/sessions/"`, `/providers/:id` → `"/providers/"`.
  const literal = (entry.path.includes(":") ? entry.path.split(":")[0] : entry.path.replace(/\*$/, "")) || "/";
  if (!serverSource.includes(`"${literal}"`)) {
    error("docs/user/reference/gateway-notes.json", `public 里的 \`${entry.path}\` 在 server.ts 中已找不到`);
  }
}
for (const routePath of internalPaths) {
  if (!serverSource.includes(`"${routePath}"`)) {
    error("docs/user/reference/gateway-notes.json", `internal 里的 \`${routePath}\` 在 server.ts 中已找不到`);
  }
}

// ──────────────────────────────────────────────
// 5. no orphan pages
// ──────────────────────────────────────────────

const inbound = new Map(pages.map((page) => [page.file, 0]));
for (const page of pages) {
  for (const match of stripFences(page.text).matchAll(/!?\[[^\]]*\]\(([^)\s]+)\)/g)) {
    const target = match[1];
    if (/^(https?:|mailto:|#)/.test(target)) continue;
    const resolved = path.resolve(path.dirname(page.file), decodeURI(target.split("#")[0]));
    if (resolved !== page.file && inbound.has(resolved)) {
      inbound.set(resolved, inbound.get(resolved) + 1);
    }
  }
}
for (const page of pages) {
  if (page.rel === "README.md") continue;
  if (inbound.get(page.file) === 0) error(page.rel, "没有任何页面链接到它（孤儿页）——在索引或相关页里加上入口");
}

// ──────────────────────────────────────────────
// 6. TypeScript snippets compile
// ──────────────────────────────────────────────

const snippetDir = path.join(ROOT, "docs/user/.snippets");
const snippetFiles = [];
for (const page of pages.filter((entry) => entry.rel.startsWith("integrating/"))) {
  codeFences(page.body.includes("```") ? page.body : page.text, "ts").forEach((code, index) => {
    const name = `${page.rel.replace(/[/\\]/g, "_").replace(/\.md$/, "")}-${index}.ts`;
    snippetFiles.push({ name, code });
  });
}
if (snippetFiles.length > 0) {
  if (!fs.existsSync(path.join(ROOT, "packages/sdk/dist/index.d.ts"))) {
    error("integrating/*", "示例代码无法编译：先构建 SDK（`pnpm turbo run build --filter @volto/sdk`）");
  } else {
    fs.rmSync(snippetDir, { recursive: true, force: true });
    fs.mkdirSync(snippetDir, { recursive: true });
    for (const snippet of snippetFiles) {
      fs.writeFileSync(path.join(snippetDir, snippet.name), snippet.code);
    }
    const tsc = path.join(ROOT, "node_modules/typescript/bin/tsc");
    try {
      execFileSync(
        process.execPath,
        [
          tsc,
          "--noEmit",
          "--strict",
          "--skipLibCheck",
          "--target",
          "ES2022",
          "--module",
          "preserve",
          "--moduleResolution",
          "bundler",
          ...snippetFiles.map((snippet) => path.join(snippetDir, snippet.name)),
        ],
        { cwd: ROOT, stdio: "pipe" },
      );
    } catch (err) {
      const output = `${err.stdout ?? ""}${err.stderr ?? ""}`.trim();
      error("integrating/*", `示例代码编译失败：\n${output}`);
    } finally {
      fs.rmSync(snippetDir, { recursive: true, force: true });
    }
  }
}

// ──────────────────────────────────────────────
// 7. shape and tone
// ──────────────────────────────────────────────

for (const page of pages) {
  const h1s = headings(page.text).filter((heading) => heading.level === 1);
  if (h1s.length !== 1) warn(page.rel, `应恰好有 1 个一级标题，当前 ${h1s.length} 个`);
  const lines = page.text.split(/\r?\n/).length;
  if (lines > 350) warn(page.rel, `页面 ${lines} 行，超过 350 行上限——拆页`);
  const type = page.data?.type;
  if ((type === "guide" || type === "tutorial") && !page.text.includes("读完你会")) {
    warn(page.rel, "缺少「读完你会」一行——读者不知道这页解决什么问题");
  }
  const jargonExempt =
    indexPages.has(page.rel) ||
    page.data?.generated === true ||
    page.rel.startsWith("integrating/") ||
    page.rel === "concepts/determinism-and-ports.md";
  if (!jargonExempt) {
    const prose = stripFences(page.body);
    for (const term of JARGON) {
      const pattern = new RegExp(`(^|[^A-Za-z])${term}([^A-Za-z]|$)`);
      if (pattern.test(prose)) {
        warn(page.rel, `出现内部术语 \`${term}\`——用户文档写现象，不写实现；集成者文档请放 integrating/`);
      }
    }
  }
  const verified = page.data?.verified;
  if (verified && /^\d{4}-\d{2}-\d{2}$/.test(verified)) {
    const age = (Date.now() - Date.parse(`${verified}T00:00:00Z`)) / 86_400_000;
    if (age > STALE_DAYS) warn(page.rel, `verified 已过去 ${Math.round(age)} 天——对照实际行为复核后更新日期`);
  }
}

// ──────────────────────────────────────────────
// 8. surface fingerprint
// ──────────────────────────────────────────────

const baseline = readJson(surfaceFilePath(), null);
if (!baseline) {
  error("docs/user/.meta/surface.json", "缺少表面基线——运行 `pnpm docs:sync`");
} else {
  const routing = readJson(routingFilePath(), {});
  const changed = [];
  for (const [name, surface] of Object.entries(surfaces.sections)) {
    if (surface.missing) {
      error("packages/sdk/dist", "缺少 SDK 构建产物，先 `pnpm turbo run build --filter @volto/sdk`");
      continue;
    }
    const previous = baseline.sections?.[name];
    if (!previous) {
      changed.push(`${name}（新增分区）`);
      continue;
    }
    if (previous.hash !== hashNames(surface.names) && previous.hash !== surface.hash) {
      const before = new Set(previous.names ?? []);
      const after = new Set(surface.names);
      const added = [...after].filter((item) => !before.has(item)).slice(0, 8);
      const removed = [...before].filter((item) => !after.has(item)).slice(0, 8);
      changed.push(
        [`${name}`, added.length ? `+ ${added.join(", ")}` : "", removed.length ? `- ${removed.join(", ")}` : ""]
          .filter(Boolean)
          .join("  "),
      );
    }
  }
  if (changed.length > 0) {
    const pagesToTouch = [...new Set(changed.flatMap((line) => routing[line.split(" ")[0]] ?? []))];
    error(
      "surface",
      [
        "用户可见表面发生了变化，但基线没有同步：",
        ...changed.map((line) => `    ${line}`),
        pagesToTouch.length ? `  受影响页面：\n${pagesToTouch.map((page) => `    - docs/user/${page}`).join("\n")}` : "",
        "  下一步：更新上述页面后运行 `pnpm docs:sync`；确认无需改文档则 `pnpm docs:ack \"理由\"`。",
      ]
        .filter(Boolean)
        .join("\n"),
    );
  }
}

// ──────────────────────────────────────────────
// 9. references in prose exist in the code
// ──────────────────────────────────────────────

// A page that names an endpoint or a config field is making a factual claim.
// Both are cheap to verify, and both rot silently: nothing else in the repo
// notices when `POST /messages/queue` is renamed or a config key disappears.
const allRoutes = extractHttpRoutes();
const allSections = extractConfigSections();
const allKeys = extractConfigKeys();
for (const page of pages) {
  const prose = stripFences(page.body);
  for (const match of prose.matchAll(/`(GET|POST|PUT|DELETE|PATCH)\s+(\/[^\s`]*)`/g)) {
    const [, method, routePath] = match;
    const known =
      allRoutes.includes(`${method} ${routePath}`) ||
      allRoutes.includes(`${method} ${routePath}*`) ||
      allRoutes.includes(`* ${routePath}`);
    if (known) continue;
    // Routes with a `:param` are matched by a regex in the handler, which the
    // extractor does not model; accept them when their static prefix is real.
    const prefix = routePath.split(":")[0];
    if (prefix.length > 1 && serverSource.includes(`"${prefix}"`)) continue;
    error(page.rel, `引用了不存在的接口：\`${method} ${routePath}\``);
  }
  for (const match of prose.matchAll(/`([a-z][A-Za-z]*)\.([a-z][A-Za-z]*)`/g)) {
    const [, section, field] = match;
    if (!allSections.includes(section)) continue;
    const known =
      (allKeys[section] ?? []).includes(field) ||
      Object.hasOwn(configNotes[section]?.fields ?? {}, field);
    if (!known) error(page.rel, `引用了不存在的配置字段：\`${section}.${field}\``);
  }
}

// ──────────────────────────────────────────────
// Report
// ──────────────────────────────────────────────

const errors = problems.filter((problem) => problem.level === "error");
const warnings = problems.filter((problem) => problem.level === "warn");
const grouped = (list) => {
  const byWhere = new Map();
  for (const problem of list) {
    if (!byWhere.has(problem.where)) byWhere.set(problem.where, []);
    byWhere.get(problem.where).push(problem.message);
  }
  return [...byWhere.entries()]
    .map(([where, messages]) => `  ${where}\n${messages.map((message) => `    · ${message}`).join("\n")}`)
    .join("\n");
};

if (errors.length > 0) {
  console.log(`docs:check — ${errors.length} 个错误，${warnings.length} 个警告\n`);
  console.log(grouped(errors));
  if (warnings.length > 0) console.log(`\n警告：\n${grouped(warnings)}`);
  process.exit(1);
}

console.log(`docs:check — 通过（${pages.length} 页，${warnings.length} 个警告）`);
if (warnings.length > 0) console.log(grouped(warnings));