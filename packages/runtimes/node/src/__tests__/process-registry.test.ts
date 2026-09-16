import { describe, it, expect, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import { createProcessRegistry } from "../process-registry.js";

const registries: Array<ReturnType<typeof createProcessRegistry>> = [];
function makeRegistry(opts?: Parameters<typeof createProcessRegistry>[0]) {
  const r = createProcessRegistry(opts);
  registries.push(r);
  return r;
}
afterEach(async () => {
  for (const r of registries.splice(0)) await r.disposeAll();
});

function pidAlive(pid: number): boolean {
  try {
    execFileSync("ps", ["-p", String(pid)], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

async function waitUntil(fn: () => boolean, ms = 5000): Promise<void> {
  const start = Date.now();
  while (!fn()) {
    if (Date.now() - start > ms) throw new Error("waitUntil timed out");
    await new Promise((r) => setTimeout(r, 25));
  }
}

describe("process registry", () => {
  it("launch returns an id and list() shows a running background process", async () => {
    const reg = makeRegistry();
    const id = await reg.launch("sleep 30");
    const info = reg.list().find((p) => p.id === id);
    expect(info).toBeDefined();
    expect(info!.running).toBe(true);
    expect(info!.kind).toBe("background");
    expect(info!.pid).toBeGreaterThan(0);
  });

  it("does not deadlock on >1MB of combined stdout+stderr (§2.1 regression)", async () => {
    // Buffer must be large enough to retain the full payload; the default
    // 256 KiB ring would legitimately drop early bytes. The deadlock
    // regression is about never blocking the child on a full pipe.
    const reg = makeRegistry({ bufferCapacityBytes: 2 * 1024 * 1024 });
    // 800KB stdout + 400KB stderr concurrently — the old launch() left both
    // pipes unread and the child blocked once the 64KB pipe buffer filled.
    const id = await reg.launch(
      `node -e "process.stdout.write('o'.repeat(800000)); process.stderr.write('e'.repeat(400000))"`,
    );
    await waitUntil(() => {
      const info = reg.list().find((p) => p.id === id);
      return info?.running === false;
    }, 15000);
    const out = await reg.readOutput(id);
    expect(out.text.length).toBeGreaterThanOrEqual(1_000_000);
    expect(out.text).toContain("o");
    expect(out.text).toContain("e");
  });

  it("killProcess really kills the OS process", async () => {
    const reg = makeRegistry();
    const id = await reg.launch("sleep 30");
    const pid = reg.list().find((p) => p.id === id)!.pid;
    expect(pidAlive(pid)).toBe(true);
    await reg.kill(id);
    await waitUntil(() => !pidAlive(pid), 5000);
    expect(pidAlive(pid)).toBe(false);
    const info = reg.list().find((p) => p.id === id)!;
    expect(info.running).toBe(false);
  });

  it("retains output after natural exit and reports running=false", async () => {
    const reg = makeRegistry();
    const id = await reg.launch("echo retained-output");
    await waitUntil(() => reg.list().find((p) => p.id === id)?.running === false);
    const out = await reg.readOutput(id);
    expect(out.text).toContain("retained-output");
    expect(reg.list().find((p) => p.id === id)!.running).toBe(false);
  });

  it("readOutput is incremental — second read is empty", async () => {
    const reg = makeRegistry();
    const id = await reg.launch("sleep 2 & echo first; sleep 0.3; echo second");
    await waitUntil(() => true); // yield
    await new Promise((r) => setTimeout(r, 200));
    const a = await reg.readOutput(id);
    const b = await reg.readOutput(id, a.cursor);
    expect(b.text === "" || !b.text.includes("first")).toBe(true);
  });

  it("unknown id throws a not-found error, never returns empty success", async () => {
    const reg = makeRegistry();
    await expect(reg.readOutput("nope")).rejects.toThrow(/not found/i);
    await expect(reg.kill("nope")).rejects.toThrow(/not found/i);
  });

  it("enforces maxBackground (default 8) with a clear error", async () => {
    const reg = makeRegistry();
    const ids: string[] = [];
    for (let i = 0; i < 8; i++) ids.push(await reg.launch("sleep 30"));
    await expect(reg.launch("sleep 30")).rejects.toThrow(/limit/i);
    for (const id of ids) await reg.kill(id);
  });

  it("disposeAll kills every running process", async () => {
    const reg = makeRegistry();
    const a = await reg.launch("sleep 30");
    const b = await reg.launch("sleep 30");
    const pidA = reg.list().find((p) => p.id === a)!.pid;
    const pidB = reg.list().find((p) => p.id === b)!.pid;
    await reg.disposeAll();
    await waitUntil(() => !pidAlive(pidA) && !pidAlive(pidB), 5000);
  });
});
