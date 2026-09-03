import { describe, it, expect } from "vitest";
import {
  createDirectoryPicker,
  normalizeDirectoryPath,
  PickerBusyError,
  PickerUnsupportedError,
} from "../fs/directory-picker.js";
import {
  CommandFailedError,
  CommandNotFoundError,
  CommandTimeoutError,
  type CommandRunner,
} from "../fs/command-runner.js";

/** A runner that records its calls (and the timeout it was given) and returns a scripted result. */
function stubRunner(
  impl: (command: string, args: string[], timeoutMs?: number) => Promise<string>,
): { runner: CommandRunner; calls: string[]; timeouts: Array<number> } {
  const calls: string[] = [];
  const timeouts: Array<number> = [];
  const runner: CommandRunner = async (command, args, timeoutMs) => {
    calls.push(command);
    timeouts.push(timeoutMs);
    return impl(command, args, timeoutMs);
  };
  return { runner, calls, timeouts };
}

describe("normalizeDirectoryPath", () => {
  it("strips the trailing slash macOS appends", () => {
    expect(normalizeDirectoryPath("/Users/leo/code/demo/")).toBe("/Users/leo/code/demo");
  });

  it("leaves a path without a trailing slash alone", () => {
    expect(normalizeDirectoryPath("/Users/leo/code/demo")).toBe("/Users/leo/code/demo");
  });

  it("keeps the filesystem root as a single slash", () => {
    expect(normalizeDirectoryPath("/")).toBe("/");
  });

  it("trims surrounding whitespace and newlines", () => {
    expect(normalizeDirectoryPath("  /Users/leo/demo/\n")).toBe("/Users/leo/demo");
  });
});

describe("createDirectoryPicker", () => {
  it("returns the normalized path chosen on macOS", async () => {
    const { runner, calls } = stubRunner(async () => "/Users/leo/code/demo/\n");
    const picker = createDirectoryPicker({ runner, platform: "darwin" });

    expect(await picker.pick()).toBe("/Users/leo/code/demo");
    expect(calls).toEqual(["osascript"]);
  });

  it("returns null when the user cancels the dialog", async () => {
    // A cancelled dialog exits non-zero with empty stdout.
    const { runner } = stubRunner(async () => {
      throw new CommandFailedError("exit 1", "");
    });
    const picker = createDirectoryPicker({ runner, platform: "darwin" });

    expect(await picker.pick()).toBeNull();
  });

  it("returns null when Windows cancels (exit 0, empty stdout)", async () => {
    // Unlike macOS/Linux, PowerShell's FolderBrowserDialog exits 0 on cancel
    // and prints nothing — the runner resolves rather than rejecting, so this
    // must be caught on the success path, not the CommandFailedError branch.
    const { runner } = stubRunner(async () => "");
    const picker = createDirectoryPicker({ runner, platform: "win32" });

    expect(await picker.pick()).toBeNull();
  });

  it("passes the configured timeout through to the runner", async () => {
    const { runner, timeouts } = stubRunner(async () => "/Users/leo/demo/");
    const picker = createDirectoryPicker({ runner, platform: "darwin", timeoutMs: 5_000 });

    await picker.pick();

    expect(timeouts).toEqual([5_000]);
  });

  it("falls back to kdialog when zenity is not installed", async () => {
    const { runner, calls } = stubRunner(async (command) => {
      if (command === "zenity") throw new CommandNotFoundError("zenity");
      return "/home/leo/demo\n";
    });
    const picker = createDirectoryPicker({ runner, platform: "linux" });

    expect(await picker.pick()).toBe("/home/leo/demo");
    expect(calls).toEqual(["zenity", "kdialog"]);
  });

  it("reports unsupported when no Linux dialog binary exists", async () => {
    const { runner } = stubRunner(async (command) => {
      throw new CommandNotFoundError(command);
    });
    const picker = createDirectoryPicker({ runner, platform: "linux" });

    await expect(picker.pick()).rejects.toBeInstanceOf(PickerUnsupportedError);
  });

  it("reports unsupported on a platform with no dialog command", async () => {
    const { runner } = stubRunner(async () => "/nope");
    const picker = createDirectoryPicker({ runner, platform: "freebsd" });

    await expect(picker.pick()).rejects.toBeInstanceOf(PickerUnsupportedError);
  });

  it("propagates a timeout rather than treating it as a cancellation", async () => {
    const { runner } = stubRunner(async () => {
      throw new CommandTimeoutError("timed out");
    });
    const picker = createDirectoryPicker({ runner, platform: "darwin" });

    await expect(picker.pick()).rejects.toBeInstanceOf(CommandTimeoutError);
  });

  it("rejects a second pick while one dialog is still open", async () => {
    let release: (value: string) => void = () => {};
    const { runner } = stubRunner(
      () => new Promise<string>((resolve) => { release = resolve; }),
    );
    const picker = createDirectoryPicker({ runner, platform: "darwin" });

    const first = picker.pick();
    await expect(picker.pick()).rejects.toBeInstanceOf(PickerBusyError);

    release("/Users/leo/demo/");
    expect(await first).toBe("/Users/leo/demo");
  });

  it("clears the busy flag after a failure so a later pick can proceed", async () => {
    let attempt = 0;
    const { runner } = stubRunner(async () => {
      attempt += 1;
      if (attempt === 1) throw new CommandTimeoutError("timed out");
      return "/Users/leo/demo/";
    });
    const picker = createDirectoryPicker({ runner, platform: "darwin" });

    await expect(picker.pick()).rejects.toBeInstanceOf(CommandTimeoutError);
    expect(await picker.pick()).toBe("/Users/leo/demo");
  });

  it("takes no caller input, so nothing can be injected into the dialog command", async () => {
    // The prompt is a server-side constant. `osascript -e` evaluates its
    // argument as AppleScript, so a pick() that accepted caller text would be
    // an injection vector. Pinning the arity keeps that door shut.
    let capturedArgs: string[] = [];
    const { runner } = stubRunner(async (_command, args) => {
      capturedArgs = args;
      return "/Users/leo/demo/";
    });
    const picker = createDirectoryPicker({ runner, platform: "darwin" });

    await picker.pick();

    expect(picker.pick).toHaveLength(0);
    expect(capturedArgs).toEqual(["-e", 'POSIX path of (choose folder with prompt "选择项目目录")']);
  });
});
