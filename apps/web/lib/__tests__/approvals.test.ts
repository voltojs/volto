import { describe, it, expect } from "vitest";
import { rememberablePrefixes } from "../approvals";

const bash = (input: Record<string, unknown>) => ({ callId: "c1", toolName: "bash", riskTier: "WRITE_HIGH", input });

describe("rememberablePrefixes", () => {
  it("offers every prefix up to the full argv", () => {
    expect(rememberablePrefixes(bash({ command: "pnpm test --filter x" }) as never)).toEqual([
      ["pnpm"],
      ["pnpm", "test"],
      ["pnpm", "test", "--filter"],
      ["pnpm", "test", "--filter", "x"],
    ]);
  });

  it("offers nothing for a compound command", () => {
    expect(rememberablePrefixes(bash({ command: "cd apps/web && pnpm test" }) as never)).toEqual([]);
    expect(rememberablePrefixes(bash({ command: "pnpm test; rm -rf /tmp/x" }) as never)).toEqual([]);
  });

  it("stops before a token that could never be matched", () => {
    // git commit -m "a b" → the fourth token contains a space
    expect(rememberablePrefixes(bash({ command: 'git commit -m "a b"' }) as never)).toEqual([
      ["git"],
      ["git", "commit"],
      ["git", "commit", "-m"],
    ]);
  });

  it("still works when bash also carries a cwd", () => {
    expect(rememberablePrefixes(bash({ command: "git status", cwd: "/tmp" }) as never)).toEqual([
      ["git"],
      ["git", "status"],
    ]);
  });

  it("offers nothing for other tools or a missing command", () => {
    expect(rememberablePrefixes({ callId: "c", toolName: "write_file", riskTier: "WRITE_HIGH", input: { path: "a" } } as never)).toEqual([]);
    expect(rememberablePrefixes({ callId: "c", toolName: "bash", riskTier: "WRITE_HIGH" } as never)).toEqual([]);
  });
});
