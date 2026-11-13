import type { LoadedSkill, ToolResult } from "@voltojs/core";
import { z } from "zod";
import { defineTool } from "../common/index.js";
import { CAP_SKILL } from "./capabilities.js";

export { CAP_SKILL } from "./capabilities.js";

/**
 * Loader seam injected by the host — the signature is SkillRegistry["load"]
 * from @voltojs/core. Returns the skill body plus its base directory, or
 * undefined when the skill is unknown or not model-invocable.
 */
export type SkillBodyLoader = (name: string) => Promise<LoadedSkill | undefined>;

/**
 * Byte cap on skill bodies returned as modelContent. A skill body is
 * unbounded user-authored markdown (with @import expansion) that travels as a
 * tool result — it does not compete for the system-layer instruction budget,
 * so the tool enforces its own cap. Per-tool truncation convention, same as
 * read_file: cap + a visible notice naming original and included sizes.
 */
const MAX_SKILL_BODY_BYTES = 64 * 1024;

/**
 * Renders the header the model needs in order to act on the body: the skill's
 * own directory, so relative resource references in the instructions resolve.
 * Shares the base directory and resolution instructions with renderSkillInjection
 * from core's skill-invocation module, but uses a different first line ("Skill: <name>")
 * to signal that this is a tool-invoked load path.
 */
function renderSkillResult(name: string, loaded: LoadedSkill): string {
  return [
    `Skill: ${name}`,
    `Base directory: ${loaded.baseDir}`,
    "Resolve any relative path in the instructions below against that directory.",
    "",
    loaded.body,
  ].join("\n");
}

/**
 * Cuts a UTF-8 byte prefix without splitting a code point, then decodes
 * losslessly. Mirrors @voltojs/core's workspace-instructions.ts `cutUtf8` —
 * duplicated here rather than imported because packages/tools/skill may only
 * `import type` from @voltojs/core, never a value.
 */
function cutUtf8(bytes: Uint8Array, maxBytes: number): Uint8Array {
  let end = Math.min(maxBytes, bytes.length);
  while (end > 0 && (bytes[end]! & 0xc0) === 0x80) end -= 1;
  return bytes.slice(0, end);
}

/**
 * Caps the rendered result at MAX_SKILL_BODY_BYTES UTF-8 bytes and appends a
 * visible truncation notice. The cut point is walked back to a UTF-8 character
 * boundary (via cutUtf8) rather than an arbitrary byte offset: slicing mid
 * codepoint would decode to a replacement character (U+FFFD, 3 bytes) that can
 * re-encode LONGER than the room allotted, pushing modelContent over the cap.
 * The header counts against the cap: the caller is promised a bounded
 * modelContent, not a bounded body.
 */
function capSkillResult(text: string): string {
  const encoded = new TextEncoder().encode(text);
  if (encoded.length <= MAX_SKILL_BODY_BYTES) return text;
  const notice =
    `\n\n[skill body truncated from ${encoded.length} to ${MAX_SKILL_BODY_BYTES} bytes` +
    " — read the files under the base directory if you need the remainder]";
  const room = MAX_SKILL_BODY_BYTES - new TextEncoder().encode(notice).length;
  const truncated = cutUtf8(encoded, Math.max(0, room));
  return new TextDecoder().decode(truncated) + notice;
}

const skillSchema = z.object({
  name: z.string().min(1).describe("The skill name, exactly as listed in the available skills catalog"),
});

/**
 * Model-facing skill loader: the catalog layer only carries skill names and
 * descriptions; this tool pulls the full instructions into the conversation
 * on demand (progressive disclosure — bodies never live in the system layer).
 */
export function createSkillTool(loader: SkillBodyLoader) {
  return defineTool({
    name: "skill",
    description:
      "Load the full instructions of a skill from the available skills catalog. " +
      "Use this when a listed skill matches the current task; the catalog only carries names and descriptions.",
    schema: skillSchema,
    requires: [CAP_SKILL],
    riskTier: "READ_ONLY",
    run: async (input): Promise<ToolResult> => {
      try {
        const loaded = await loader(input.name);
        if (loaded === undefined) {
          return {
            modelContent: `Unknown or non-invocable skill: ${input.name}`,
            isError: true,
          };
        }
        return {
          modelContent: capSkillResult(renderSkillResult(input.name, loaded)),
          displayMetadata: { baseDir: loaded.baseDir },
        };
      } catch (err: unknown) {
        const error = err instanceof Error ? err.message : String(err);
        return { modelContent: `Skill load failed: ${error}`, isError: true };
      }
    },
  });
}
