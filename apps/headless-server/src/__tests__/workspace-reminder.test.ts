/**
 * Gateway-side workspace reminder builder (spec 2026-11-10 D4).
 *
 * The SDK never touches git: the host resolves the directory into the
 * `{key, announce}` pair the reducer injects. Every failure mode degrades to
 * "say less" — a probe that cannot run must never fail a turn.
 */
import { describe, it, expect } from "vitest";
import {
  buildWorkspaceReminder,
  type GitProbe,
} from "../workspace-reminder.js";

/** A probe driven by a table: first matching argv wins. */
function probeFrom(
  table: Array<{
    match: string;
    code?: number;
    stdout?: string;
    stderr?: string;
    throws?: boolean;
  }>,
): GitProbe {
  return async (args) => {
    const hit = table.find((row) => args.includes(row.match));
    if (hit === undefined) {
      throw new Error(`unexpected git call: ${args.join(" ")}`);
    }
    if (hit.throws === true) throw new Error("git not found");
    return {
      code: hit.code ?? 0,
      stdout: hit.stdout ?? "",
      stderr: hit.stderr ?? "",
    };
  };
}

describe("buildWorkspaceReminder", () => {
  it("names the directory and the branch on a normal checkout", async () => {
    const reminder = await buildWorkspaceReminder(
      "/repo",
      probeFrom([{ match: "--abbrev-ref", stdout: "feat/x\n" }]),
    );

    expect(reminder).toBeDefined();
    expect(reminder!.announce).toContain("Working directory: /repo");
    expect(reminder!.announce).toContain("Git branch: feat/x");
    expect(reminder!.key).toContain("/repo");
    expect(reminder!.key).toContain("feat/x");
  });

  it("fingerprints the branch, not just the directory", async () => {
    const onMain = await buildWorkspaceReminder(
      "/repo",
      probeFrom([{ match: "--abbrev-ref", stdout: "main\n" }]),
    );
    const onFeature = await buildWorkspaceReminder(
      "/repo",
      probeFrom([{ match: "--abbrev-ref", stdout: "feat/x\n" }]),
    );
    const again = await buildWorkspaceReminder(
      "/repo",
      probeFrom([{ match: "--abbrev-ref", stdout: "main\n" }]),
    );

    expect(onMain!.key).toBe(again!.key);
    expect(onMain!.key).not.toBe(onFeature!.key);
  });

  it("reports a detached HEAD by short sha", async () => {
    const reminder = await buildWorkspaceReminder(
      "/repo",
      probeFrom([
        { match: "--abbrev-ref", stdout: "HEAD\n" },
        { match: "--short", stdout: "a1b2c3d\n" },
      ]),
    );

    expect(reminder!.announce).toContain("Git branch: (detached at a1b2c3d)");
  });

  it("says there is no repository outside a work tree", async () => {
    const reminder = await buildWorkspaceReminder(
      "/tmp/plain",
      probeFrom([
        {
          match: "--abbrev-ref",
          code: 128,
          stderr: "fatal: not a git repository (or any of the parent directories): .git\n",
        },
      ]),
    );

    expect(reminder!.announce).toContain("Git repository: none");
    expect(reminder!.announce).not.toContain("Git branch:");
  });

  it("reports only the directory when the probe cannot run", async () => {
    const reminder = await buildWorkspaceReminder(
      "/repo",
      probeFrom([{ match: "--abbrev-ref", throws: true }]),
    );

    expect(reminder!.announce).toBe("Working directory: /repo");
    expect(reminder!.announce).not.toContain("Git branch:");
  });

  it("stays silent about the branch when git fails for an unknown reason", async () => {
    // A broken repo is not the same as "no repository": claiming either would
    // be a guess. Report the directory and let the model ask.
    const reminder = await buildWorkspaceReminder(
      "/repo",
      probeFrom([
        { match: "--abbrev-ref", code: 128, stderr: "fatal: dubious ownership\n" },
      ]),
    );

    expect(reminder!.announce).toBe("Working directory: /repo");
    expect(reminder!.announce).not.toContain("Git repository: none");
  });

  it("returns undefined for an empty directory", async () => {
    await expect(
      buildWorkspaceReminder("", probeFrom([])),
    ).resolves.toBeUndefined();
  });
});