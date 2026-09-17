import { describe, it, expect } from "vitest";
import type {
  FileWatchEvent,
  FileWatchRegistration,
  FileWatcher,
  FileChangedInput,
  AgentInput,
} from "../index.js";

describe("file watch types", () => {
  it("FileChangedInput is assignable to AgentInput", () => {
    const input: FileChangedInput = {
      type: "file_changed",
      watchId: "watch-0",
      events: [{ type: "change", path: "src/a.ts", mtime: 1 }],
    };
    const asUnion: AgentInput = input;
    expect(asUnion.type).toBe("file_changed");
  });

  it("FileWatcher surface is the three methods from the design", () => {
    const fake: FileWatcher = {
      async watch(_reg: FileWatchRegistration, _cb: (e: FileWatchEvent[]) => void) {
        return "w1";
      },
      async unwatch() {
        return true;
      },
      async list() {
        return [];
      },
    };
    expect(typeof fake.watch).toBe("function");
  });
});
