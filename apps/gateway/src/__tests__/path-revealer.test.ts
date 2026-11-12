import { describe, expect, it } from "vitest";
import {
  createPathRevealer,
  RevealInvalidPathError,
  RevealUnsupportedError,
} from "../fs/path-revealer.js";
import { CommandNotFoundError } from "../fs/command-runner.js";

describe("createPathRevealer", () => {
  it("runs `open -R` on darwin", async () => {
    const calls: Array<{ command: string; args: string[] }> = [];
    const revealer = createPathRevealer({
      runner: async (command, args) => {
        calls.push({ command, args });
        return "";
      },
      platform: "darwin",
    });

    await revealer.reveal("/Users/demo/project");
    expect(calls).toEqual([
      { command: "open", args: ["-R", "/Users/demo/project"] },
    ]);
  });

  it("opens the parent directory on linux", async () => {
    const calls: Array<{ command: string; args: string[] }> = [];
    const revealer = createPathRevealer({
      runner: async (command, args) => {
        calls.push({ command, args });
        return "";
      },
      platform: "linux",
    });

    await revealer.reveal("/home/demo/project/file.txt");
    expect(calls).toEqual([
      { command: "xdg-open", args: ["/home/demo/project"] },
    ]);
  });

  it("passes /select, as a single explorer argument on win32", async () => {
    const calls: Array<{ command: string; args: string[] }> = [];
    const revealer = createPathRevealer({
      runner: async (command, args) => {
        calls.push({ command, args });
        return "";
      },
      platform: "win32",
    });

    await revealer.reveal("C:\\Users\\demo\\project");
    expect(calls).toEqual([
      { command: "explorer", args: ["/select,C:\\Users\\demo\\project"] },
    ]);
  });

  it("treats a non-zero explorer exit as success on win32", async () => {
    const revealer = createPathRevealer({
      runner: async () => {
        const { CommandFailedError } = await import("../fs/command-runner.js");
        throw new CommandFailedError("explorer exited with 1", "");
      },
      platform: "win32",
    });

    await expect(revealer.reveal("C:\\tmp\\x")).resolves.toBeUndefined();
  });

  it("rejects a relative or empty path", async () => {
    const revealer = createPathRevealer({
      runner: async () => "",
      platform: "darwin",
    });

    await expect(revealer.reveal("relative/path")).rejects.toBeInstanceOf(
      RevealInvalidPathError,
    );
    await expect(revealer.reveal("   ")).rejects.toBeInstanceOf(
      RevealInvalidPathError,
    );
  });

  it("maps an unsupported platform to RevealUnsupportedError", async () => {
    const revealer = createPathRevealer({
      runner: async () => "",
      platform: "freebsd",
    });

    await expect(revealer.reveal("/tmp/x")).rejects.toBeInstanceOf(
      RevealUnsupportedError,
    );
  });

  it("falls through when the binary is missing", async () => {
    const revealer = createPathRevealer({
      runner: async () => {
        throw new CommandNotFoundError("open is not installed");
      },
      platform: "darwin",
    });

    await expect(revealer.reveal("/tmp/x")).rejects.toBeInstanceOf(
      RevealUnsupportedError,
    );
  });
});
