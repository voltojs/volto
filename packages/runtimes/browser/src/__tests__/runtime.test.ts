import { describe, it, expect, beforeEach } from "vitest";
import { createBrowserFileSystem } from "../filesystem.js";
import { createBrowserTokenizer } from "../tokenizer.js";

describe("BrowserFileSystem", () => {
  let fs: ReturnType<typeof createBrowserFileSystem>;

  beforeEach(() => {
    fs = createBrowserFileSystem();
  });

  it("write and read round-trips correctly", async () => {
    await fs.write("/test.txt", "hello world");
    const result = await fs.read("/test.txt");
    expect(result.content).toBe("hello world");
    expect(result.totalLines).toBe(1);
    expect(result.truncated).toBe(false);
  });

  it("read with offset and limit", async () => {
    await fs.write("/lines.txt", "line1\nline2\nline3\nline4\nline5");
    const result = await fs.read("/lines.txt", 2, 2);
    expect(result.content).toBe("line2\nline3");
    expect(result.totalLines).toBe(5);
    expect(result.truncated).toBe(true);
  });

  it("stat returns correct info", async () => {
    await fs.write("/file.txt", "data");
    const stat = await fs.stat("/file.txt");
    expect(stat.path).toBe("/file.txt");
    expect(stat.isDirectory).toBe(false);
    expect(stat.size).toBe(4);
    expect(stat.mtime).toBeGreaterThan(0);
  });

  it("list returns directory entries", async () => {
    await fs.write("/dir/a.txt", "a");
    await fs.write("/dir/b.txt", "b");
    const result = await fs.list("/dir");
    expect(result.entries).toHaveLength(2);
    expect(result.entries.map((e) => e.name).sort()).toEqual(["a.txt", "b.txt"]);
  });

  it("glob finds matching files", async () => {
    await fs.write("/src/index.ts", "export {}");
    await fs.write("/src/util.ts", "export {}");
    await fs.write("/test/index.test.ts", "import {}");
    const result = await fs.glob("**/*.ts");
    expect(result.paths.length).toBeGreaterThanOrEqual(2);
  });

  it("grep finds matching lines", async () => {
    await fs.write("/code.ts", "const x = 1;\nconst y = 2;\nconst z = 3;");
    const result = await fs.grep("const", { limit: 10 });
    expect(result.matches).toHaveLength(3);
    expect(result.truncated).toBe(false);
  });

  it("read throws for nonexistent file", async () => {
    await expect(fs.read("/missing.txt")).rejects.toThrow("File not found");
  });
});

describe("BrowserTokenizer", () => {
  it("counts tokens by character heuristic", () => {
    const tokenizer = createBrowserTokenizer();
    expect(tokenizer.count("")).toBe(0);
    expect(tokenizer.count("abcd")).toBe(1);
    expect(tokenizer.count("abcdefgh")).toBe(2);
    expect(tokenizer.count("hello")).toBe(2); // 5 chars / 4 = 1.25 → ceil = 2
  });

  it("respects custom charsPerToken", () => {
    const tokenizer = createBrowserTokenizer({ charsPerToken: 2 });
    expect(tokenizer.count("abcd")).toBe(2);
  });
});
