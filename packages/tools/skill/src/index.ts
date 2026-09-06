import type { ToolResult } from "@volto/core";
import { z } from "zod";
import { defineTool } from "@volto/tools-common";
import { CAP_SKILL } from "./capabilities.js";

export { CAP_SKILL } from "./capabilities.js";

/**
 * Loader seam injected by the host — the signature is SkillRegistry["load"]
 * from @volto/core. Returns the full skill body, or undefined when the skill
 * is unknown or not model-invocable.
 */
export type SkillBodyLoader = (name: string) => Promise<string | undefined>;

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
        const body = await loader(input.name);
        if (body === undefined) {
          return {
            modelContent: `Unknown or non-invocable skill: ${input.name}`,
            isError: true,
          };
        }
        return { modelContent: body };
      } catch (err: unknown) {
        const error = err instanceof Error ? err.message : String(err);
        return { modelContent: `Skill load failed: ${error}`, isError: true };
      }
    },
  });
}
