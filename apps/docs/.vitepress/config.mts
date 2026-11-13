import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitepress";

const here = path.dirname(fileURLToPath(import.meta.url));
const srcDir = path.resolve(here, "../../../docs/user");
const outDir = path.resolve(here, "../dist");

/** Read the page title from front matter, falling back to the H1. */
function pageTitle(file: string): string {
  const text = fs.readFileSync(file, "utf8");
  const frontMatter = text.match(/^---\n([\s\S]*?)\n---/);
  const title = frontMatter?.[1].match(/^title:\s*(.+)$/m)?.[1] ?? text.match(/^#\s+(.+)$/m)?.[1];
  return (title ?? path.basename(file, ".md")).trim().replace(/^["']|["']$/g, "");
}

function pages(dir: string, prefix: string) {
  const absolute = path.join(srcDir, dir);
  if (!fs.existsSync(absolute)) return [];
  return fs
    .readdirSync(absolute)
    .filter((name) => name.endsWith(".md"))
    .sort()
    .map((name) => ({
      text: pageTitle(path.join(absolute, name)),
      link: `${prefix}/${dir}/${name.replace(/\.md$/, "")}`,
    }));
}

function track(dir: string, prefix: string) {
  const groups = [
    ["tutorial", "Tutorial"],
    ["guides", "Guides"],
    ["reference", "Reference"],
  ] as const;
  return groups
    .map(([group, label]) => {
      const items = pages(`${dir}/${group}`, prefix);
      return items.length > 0 ? { text: label, items } : null;
    })
    .filter((group): group is { text: string; items: { text: string; link: string }[] } => group !== null);
}

function sidebar(prefix: string, labels: { using: string; integrating: string; concepts: string }) {
  return [
    { text: labels.using, items: track("using", prefix) },
    { text: labels.integrating, items: track("integrating", prefix) },
    { text: labels.concepts, items: pages("concepts", prefix) },
  ];
}

export default defineConfig({
  title: "Volto",
  description: "A coding agent that runs on your machine.",
  base: "/volto/",
  srcDir,
  outDir,
  cleanUrls: false,
  rewrites: {
    "README.md": "index.md",
    "zh/README.md": "zh/index.md",
  },
  locales: {
    root: { label: "English", lang: "en" },
    zh: { label: "简体中文", lang: "zh-CN", link: "/zh/" },
  },
  themeConfig: {
    nav: [
      { text: "Guide", link: "/using/tutorial/01-install" },
      { text: "Integrate", link: "/integrating/tutorial/01-embed-agent" },
      { text: "简体中文", link: "/zh/" },
    ],
    sidebar: {
      "/": sidebar("", { using: "Using volto", integrating: "Integrating", concepts: "Concepts" }),
      "/zh/": sidebar("/zh", { using: "使用 volto", integrating: "集成", concepts: "概念" }),
    },
    search: { provider: "local" },
    outline: { level: [2, 3] },
    lastUpdated: true,
    docFooter: { prev: "Previous", next: "Next" },
  },
  srcExclude: ["WRITING.md", "zh/WRITING.md", ".meta/**"],
  ignoreDeadLinks: false,
});