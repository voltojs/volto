import type { PendingToolCall, ToolResult, FileSystem } from "@agent-core/core";
import { evaluateEditGate, evaluateOverwriteGate } from "@agent-core/core";
import type { FileTool } from "@agent-core/tools-fs";
import {
  createReadFileTool,
  createEditFileTool,
  createWriteFileTool,
  createLsTool,
  createGlobTool,
  createGrepTool,
} from "@agent-core/tools-fs";
import type { ToolExecutor } from "./runner.js";

export interface CreateFsToolExecutorOptions {
  fs: FileSystem;
}

/**
 * Build a tool executor backed by a FileSystem port.
 *
 * Read-before-edit + staleness gating runs HERE, before any side effect, using
 * the serializable readFiles state threaded in via the executor context (so it
 * survives resume). The pure decision lives in @agent-core/core (evaluate*Gate);
 * this layer only supplies on-disk facts (existence, current mtime).
 *
 * NOTE: routeToolCall / capability gating is handled by the Runner before
 * invoking this executor — no need to duplicate that logic here.
 */
export function createFsToolExecutor(options: CreateFsToolExecutorOptions): ToolExecutor {
  const tools: FileTool[] = [
    createReadFileTool(options.fs),
    createEditFileTool(options.fs),
    createWriteFileTool(options.fs),
    createLsTool(options.fs),
    createGlobTool(options.fs),
    createGrepTool(options.fs),
  ];

  return async (call: PendingToolCall, ctx): Promise<ToolResult> => {
    const tool = tools.find((entry) => entry.definition.name === call.name);
    if (!tool) {
      return { modelContent: `Unknown tool: ${call.name}`, isError: true };
    }

    const targetPath = typeof call.input.path === "string" ? call.input.path : undefined;
    const readFiles = ctx.readFiles;

    // ── Pre-write gate (before any side effect) ──
    if (targetPath && call.name === "edit_file") {
      let currentMtime: number;
      try {
        currentMtime = (await options.fs.stat(targetPath)).mtime;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return { modelContent: `edit_file failed: ${message}`, isError: true };
      }
      const blocked = evaluateEditGate(readFiles, targetPath, currentMtime);
      if (blocked) {
        return blocked;
      }
    }

    if (targetPath && call.name === "write_file") {
      let exists = true;
      try {
        await options.fs.stat(targetPath);
      } catch {
        exists = false;
      }
      const blocked = evaluateOverwriteGate(readFiles, targetPath, exists);
      if (blocked) {
        return blocked;
      }
    }

    return tool.handler(call.input);
  };
}
