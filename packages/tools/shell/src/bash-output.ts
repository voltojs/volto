import type { Shell, ToolResult } from "@volto/core";
import { z } from "zod";
import { defineTool } from "@volto/tools-common";
import { CAP_SHELL_EXEC } from "./capabilities.js";

const bashOutputSchema = z.object({
  process_id: z.string().describe("Process id returned by bash run_in_background"),
  cursor: z
    .string()
    .optional()
    .describe(
      "Opaque cursor from a previous bash_output next_cursor. Omit to re-read from the start of the retained buffer.",
    ),
});

export function createBashOutputTool(shell: Shell) {
  return defineTool({
    name: "bash_output",
    description:
      "Read incremental output from a background process started with bash(run_in_background=true). " +
      "Every result ends with next_cursor=… — pass that value as cursor on the next call to avoid re-reading the same bytes.",
    schema: bashOutputSchema,
    requires: [CAP_SHELL_EXEC],
    riskTier: "READ_ONLY",
    run: async (input): Promise<ToolResult> => {
      if (!shell.readProcessOutput) {
        return {
          modelContent: "bash_output is not available: the active shell has no process registry.",
          isError: true,
        };
      }
      try {
        const out = await shell.readProcessOutput(input.process_id, input.cursor);
        const overflowNote = out.overflowed
          ? `\n\n(earlier output discarded from the ring buffer; ${out.droppedBytes} bytes total)`
          : "";
        const body = out.text.length === 0 ? "(no new output)" : out.text;
        // Cursor must be model-visible: displayMetadata is UI-only, and a
        // model that never sees the cursor cannot do an incremental second
        // read (it re-reads from the start and repeats the same output).
        const cursorNote = `\n\nnext_cursor=${out.cursor}`;
        return {
          modelContent: `${body}${overflowNote}${cursorNote}`,
          displayMetadata: {
            processId: input.process_id,
            cursor: out.cursor,
            overflowed: out.overflowed,
            droppedBytes: out.droppedBytes,
            length: out.text.length,
          },
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return { modelContent: `bash_output failed: ${message}`, isError: true };
      }
    },
  });
}
