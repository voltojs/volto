import { describe, it, expect } from "vitest";
import type { FileWatcher, FileWatchRegistration, FileWatchEvent, ToolDefinition } from "@volto/core";
import { filterVisibleTools } from "@volto/core";
import { createWatchFilesTool } from "../watch-files.js";
import { createUnwatchFilesTool } from "../unwatch-files.js";
import { createListWatchesTool } from "../list-watches.js";
import { CAP_FS_WATCH } from "../capabilities.js";
import { FS_TOOL_NAMES } from "../tool-names.js";

/** Build a FileWatcher fake; override only the methods a given test exercises. */
function fakeWatcher(overrides: Partial<FileWatcher> = {}): FileWatcher {
  const reject = () => Promise.reject(new Error("not implemented"));
  return {
    watch: reject as FileWatcher["watch"],
    unwatch: reject as FileWatcher["unwatch"],
    list: reject as FileWatcher["list"],
    ...overrides,
  };
}

function watchDefinitions(): ToolDefinition[] {
  const watcher = fakeWatcher();
  return [
    createWatchFilesTool(watcher).definition,
    createUnwatchFilesTool(watcher).definition,
    createListWatchesTool(watcher).definition,
  ];
}

describe("createWatchFilesTool", () => {
  it("rejects a missing paths field via schema (F-012)", async () => {
    const tool = createWatchFilesTool(fakeWatcher());
    const result = await tool.handler({});
    expect(result.isError).toBe(true);
    expect(result.modelContent).toContain("Invalid input");
  });

  it("rejects an empty paths array via schema (F-012)", async () => {
    const tool = createWatchFilesTool(fakeWatcher());
    const result = await tool.handler({ paths: [] });
    expect(result.isError).toBe(true);
    expect(result.modelContent).toContain("Invalid input");
  });

  it("passes debounceMs default 200 to watch when debounce_ms is omitted (F-013)", async () => {
    let captured: FileWatchRegistration | undefined;
    const tool = createWatchFilesTool(
      fakeWatcher({
        watch: async (reg) => {
          captured = reg;
          return "w1";
        },
      }),
    );
    const result = await tool.handler({ paths: ["src"] });
    expect(result.isError).toBeFalsy();
    expect(captured?.debounceMs).toBe(200);
  });

  it("rejects debounce_ms below 50 or above 5000 (F-013)", async () => {
    const tool = createWatchFilesTool(fakeWatcher());
    const tooSmall = await tool.handler({ paths: ["src"], debounce_ms: 10 });
    expect(tooSmall.isError).toBe(true);
    expect(tooSmall.modelContent).toContain("Invalid input");
    const tooLarge = await tool.handler({ paths: ["src"], debounce_ms: 99999 });
    expect(tooLarge.isError).toBe(true);
    expect(tooLarge.modelContent).toContain("Invalid input");
  });

  it("forwards paths, glob, and an explicit debounce_ms to the port (F-013)", async () => {
    let captured: FileWatchRegistration | undefined;
    let capturedCb: ((events: FileWatchEvent[]) => void) | undefined;
    const tool = createWatchFilesTool(
      fakeWatcher({
        watch: async (reg, cb) => {
          captured = reg;
          capturedCb = cb;
          return "w7";
        },
      }),
    );
    const result = await tool.handler({
      paths: ["src", "docs"],
      glob: "**/*.ts",
      debounce_ms: 500,
    });
    expect(result.isError).toBeFalsy();
    expect(captured).toEqual({ paths: ["src", "docs"], glob: "**/*.ts", debounceMs: 500 });
    // The tool registers a no-op callback; event wiring is the SDK's job.
    expect(typeof capturedCb).toBe("function");
  });

  it("returns watchId in modelContent and displayMetadata (F-014)", async () => {
    const tool = createWatchFilesTool(
      fakeWatcher({
        watch: async () => "watch-3",
      }),
    );
    const result = await tool.handler({ paths: ["src/a.ts", "src/b.ts"], glob: "**/*.ts" });
    expect(result.isError).toBeFalsy();
    expect(result.modelContent).toContain("watch-3");
    expect(result.modelContent).toContain("2 path(s)");
    expect(result.displayMetadata).toMatchObject({
      watchId: "watch-3",
      paths: ["src/a.ts", "src/b.ts"],
      glob: "**/*.ts",
      debounceMs: 200,
    });
  });

  it("returns an isError result when the port throws", async () => {
    const tool = createWatchFilesTool(
      fakeWatcher({
        watch: async () => {
          throw new Error("outside workspace root");
        },
      }),
    );
    const result = await tool.handler({ paths: ["../escape"] });
    expect(result.isError).toBe(true);
    expect(result.modelContent).toContain("watch_files failed");
    expect(result.modelContent).toContain("outside workspace root");
  });
});

describe("createUnwatchFilesTool", () => {
  it("rejects a missing watch_id via schema", async () => {
    const tool = createUnwatchFilesTool(fakeWatcher());
    const result = await tool.handler({});
    expect(result.isError).toBe(true);
    expect(result.modelContent).toContain("Invalid input");
  });

  it("reports cancelled=true for a known watch id (F-015)", async () => {
    let requested: string | undefined;
    const tool = createUnwatchFilesTool(
      fakeWatcher({
        unwatch: async (id) => {
          requested = id;
          return true;
        },
      }),
    );
    const result = await tool.handler({ watch_id: "watch-1" });
    expect(result.isError).toBeFalsy();
    expect(requested).toBe("watch-1");
    expect(result.modelContent).toContain("cancelled=true");
    expect(result.displayMetadata).toMatchObject({ watchId: "watch-1", cancelled: true });
  });

  it("reports cancelled=false for an unknown id (F-015)", async () => {
    const tool = createUnwatchFilesTool(
      fakeWatcher({
        unwatch: async () => false,
      }),
    );
    const result = await tool.handler({ watch_id: "ghost" });
    expect(result.isError).toBeFalsy();
    expect(result.modelContent).toContain("cancelled=false");
    expect(result.displayMetadata?.cancelled).toBe(false);
  });
});

describe("createListWatchesTool", () => {
  it("lists active watch ids (F-016)", async () => {
    const tool = createListWatchesTool(
      fakeWatcher({
        list: async () => ["watch-0", "watch-1"],
      }),
    );
    const result = await tool.handler({});
    expect(result.isError).toBeFalsy();
    expect(result.modelContent).toBe("watch-0\nwatch-1");
    expect(result.displayMetadata?.watchIds).toEqual(["watch-0", "watch-1"]);
  });

  it('returns "(none)" when there are no active watches (F-016)', async () => {
    const tool = createListWatchesTool(
      fakeWatcher({
        list: async () => [],
      }),
    );
    const result = await tool.handler({});
    expect(result.modelContent).toBe("(none)");
    expect(result.displayMetadata?.watchIds).toEqual([]);
  });
});

describe("watch tool capability gating (F-017, F-018)", () => {
  it("hides all three watch tools when filesystem:watch is absent", () => {
    const visible = filterVisibleTools(watchDefinitions(), new Set());
    expect(visible).toHaveLength(0);

    const readOnlyOnly = filterVisibleTools(watchDefinitions(), new Set(["filesystem:read"]));
    expect(readOnlyOnly).toHaveLength(0);
  });

  it("exposes all three watch tools when filesystem:watch is present", () => {
    const visible = filterVisibleTools(watchDefinitions(), new Set([CAP_FS_WATCH]));
    expect(visible.map((t) => t.name).sort()).toEqual(
      ["list_watches", "unwatch_files", "watch_files"].sort(),
    );
  });

  it("declares requires filesystem:watch and riskTier READ_ONLY on each definition", () => {
    for (const def of watchDefinitions()) {
      expect(def.requires).toEqual([CAP_FS_WATCH]);
      expect(def.riskTier).toBe("READ_ONLY");
    }
  });

  it("registers the three names in FS_TOOL_NAMES", () => {
    expect(FS_TOOL_NAMES.has("watch_files")).toBe(true);
    expect(FS_TOOL_NAMES.has("unwatch_files")).toBe(true);
    expect(FS_TOOL_NAMES.has("list_watches")).toBe(true);
  });
});
