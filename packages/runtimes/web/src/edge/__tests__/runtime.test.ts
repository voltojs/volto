import { describe, it, expect, beforeEach } from "vitest";
import { createEdgeFileSystem } from "../filesystem.js";

describe("EdgeFileSystem", () => {
  let fs: ReturnType<typeof createEdgeFileSystem>;

  beforeEach(() => {
    fs = createEdgeFileSystem();
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
    expect(stat.size).toBe(4);
    expect(stat.mtime).toBeGreaterThan(0);
  });

  it("list returns entries", async () => {
    await fs.write("/dir/a.txt", "a");
    await fs.write("/dir/b.txt", "b");
    const result = await fs.list("/dir");
    expect(result.entries.length).toBeGreaterThanOrEqual(2);
  });

  it("glob finds matching files", async () => {
    await fs.write("/src/index.ts", "export {}");
    await fs.write("/src/util.ts", "export {}");
    const result = await fs.glob("**/*.ts");
    expect(result.paths.length).toBeGreaterThanOrEqual(2);
  });

  it("grep finds matching lines", async () => {
    await fs.write("/code.ts", "const x = 1;\nconst y = 2;\nconst z = 3;");
    const result = await fs.grep("const", { limit: 10 });
    expect(result.matches).toHaveLength(3);
  });

  it("read throws for nonexistent file", async () => {
    await expect(fs.read("/missing.txt")).rejects.toThrow("File not found");
  });
});
