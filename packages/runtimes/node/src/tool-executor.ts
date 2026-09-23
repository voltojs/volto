import type { PendingToolCall, ToolResult, FileSystem, AttachmentStore } from "@volto/core";
import { evaluateEditGate, evaluateOverwriteGate } from "@volto/core";
import type { FileTool, PdfLikeParser } from "@volto/tools-fs";
import {
  createReadFileTool,
  createEditFileTool,
  createWriteFileTool,
  createApplyPatchTool,
  createMultiEditTool,
  createLsTool,
  createGlobTool,
  createGrepTool,
} from "@volto/tools-fs";
import type { ToolExecutor } from "./runner.js";

export interface CreateFsToolExecutorOptions {
  fs: FileSystem;
  /**
   * Attachment store for the image path of read_file. Without it, image
   * reads return isError — the bytes have nowhere durable to live as a ref.
   */
  attachments?: AttachmentStore;
  /**
   * Tri-state vision gate forwarded to read_file. Absent means unknown
   * (do not gate); only explicit `false` rejects image reads.
   */
  visionSupported?: boolean;
  /**
   * Document parser forwarded to read_file for `.pdf` dispatch. The
   * executor builds its own tool instances (read-before-edit gating lives
   * here), so every option the VISIBLE definition gets must be threaded
   * here too — otherwise the model sees a PDF-capable read_file while
   * execution answers "no document parser is wired".
   */
  documentParser?: PdfLikeParser;
}

/**
 * Build a tool executor backed by a FileSystem port.
 *
 * Read-before-edit + staleness gating runs HERE, before any side effect, using
 * the serializable readFiles state threaded in via the executor context (so it
 * survives resume). The pure decision lives in @volto/core (evaluate*Gate);
 * this layer only supplies on-disk facts (existence, current mtime).
 *
 * NOTE: routeToolCall / capability gating is handled by the Runner before
 * invoking this executor — no need to duplicate that logic here.
 */
export function createFsToolExecutor(options: CreateFsToolExecutorOptions): ToolExecutor {
  const tools: FileTool[] = [
    createReadFileTool(options.fs, {
      attachments: options.attachments,
      visionSupported: options.visionSupported,
      documentParser: options.documentParser,
    }),
    createEditFileTool(options.fs),
    createWriteFileTool(options.fs),
    createApplyPatchTool(options.fs),
    createMultiEditTool(options.fs),
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
    // apply_patch and multi_edit inherit the same read-before-edit gate as edit_file
    if (targetPath && (call.name === "edit_file" || call.name === "apply_patch" || call.name === "multi_edit")) {
      let currentMtime: number;
      try {
        currentMtime = (await options.fs.stat(targetPath)).mtime;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return { modelContent: `${call.name} failed: ${message}`, isError: true };
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
