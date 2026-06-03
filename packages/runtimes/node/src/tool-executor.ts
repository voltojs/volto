import type { PendingToolCall, ToolResult, ToolDefinition, FileSystem, Clock } from "@agent-core/core";
import { routeToolCall } from "@agent-core/core";
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

interface ReadVersionEntry {
  version: number;
  readAt: number;
}

export interface CreateFsToolExecutorOptions {
  fs: FileSystem;
  clock: Clock;
}

export function createFsToolExecutor(options: CreateFsToolExecutorOptions): ToolExecutor {
  const tools: FileTool[] = [
    createReadFileTool(options.fs),
    createEditFileTool(options.fs),
    createWriteFileTool(options.fs),
    createLsTool(options.fs),
    createGlobTool(options.fs),
    createGrepTool(options.fs),
  ];

  const fallbackDefinition: ToolDefinition = tools[0]?.definition ?? {
    name: "__fallback__",
    description: "fallback",
    inputSchema: {},
    requires: [],
    riskTier: "READ_ONLY",
  };

  const readVersions = new Map<string, ReadVersionEntry>();

  return async (call: PendingToolCall): Promise<ToolResult> => {
    const routed = routeToolCall(
      tools.map((entry) => entry.definition),
      new Set(["filesystem:read", "filesystem:write"]),
      call,
    );
    if (routed.result) {
      return routed.result;
    }

    const matchedTool = tools.find((entry) => entry.definition.name === call.name);
    const tool: FileTool = matchedTool ?? {
      definition: fallbackDefinition,
      handler: async (): Promise<ToolResult> => ({
        modelContent: `Unknown tool: ${call.name}`,
        isError: true,
      }),
    };

    const targetPath = typeof call.input.path === "string" ? call.input.path : undefined;

    if (call.name === "write_file" && targetPath) {
      try {
        await options.fs.stat(targetPath);
        if (!readVersions.has(targetPath)) {
          return {
            modelContent: `write_file blocked: read_file "${targetPath}" was not called before overwriting.`,
            isError: true,
          };
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (!message.includes("ENOENT")) {
          return {
            modelContent: `write_file failed: ${message}`,
            isError: true,
          };
        }
      }
    }

    const toolResult = await tool.handler(call.input);
    const readFileMeta = toolResult.displayMetadata?.readFile as { path?: string } | undefined;
    const writeFileMeta = toolResult.displayMetadata?.writeFile as { path?: string } | undefined;

    if (readFileMeta?.path && !toolResult.isError) {
      const readAt = options.clock.now();
      readVersions.set(readFileMeta.path, {
        version: (readVersions.get(readFileMeta.path)?.version ?? 0) + 1,
        readAt,
      });
      toolResult.displayMetadata = {
        ...toolResult.displayMetadata,
        readAt,
      };
    }

    if (writeFileMeta?.path && call.name === "edit_file") {
      const versionEntry = readVersions.get(writeFileMeta.path);
      if (!versionEntry) {
        return {
          modelContent: `edit_file blocked: read_file "${writeFileMeta.path}" was not called before editing.`,
          isError: true,
        };
      }

      const latestStat = await options.fs.stat(writeFileMeta.path);
      if (latestStat.mtime > versionEntry.readAt) {
        return {
          modelContent: `edit_file blocked: "${writeFileMeta.path}" changed after the last read. Re-read the file before editing.`,
          isError: true,
        };
      }
    }

    return toolResult;
  };
}
