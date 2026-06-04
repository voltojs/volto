import type { ToolDefinition, ToolResult, RiskTier, Capability, JSONSchema } from "@agent-core/core";
import { z } from "zod";
import type { Tool } from "./tool.js";

/**
 * Build a Tool from a Zod schema. The Zod schema is the single source of
 * truth: its JSON Schema (via z.toJSONSchema) is exposed to the model, and
 * the same schema validates input at runtime. Invalid input → isError ToolResult
 * (never throws), so the model can self-correct.
 */
export function defineTool<S extends z.ZodType>(spec: {
  name: string;
  description: string;
  schema: S;
  requires: Capability[];
  riskTier: RiskTier;
  run: (input: z.infer<S>) => Promise<ToolResult>;
}): Tool {
  const definition: ToolDefinition = {
    name: spec.name,
    description: spec.description,
    inputSchema: z.toJSONSchema(spec.schema) as unknown as JSONSchema,
    requires: spec.requires,
    riskTier: spec.riskTier,
  };

  return {
    definition,
    handler: async (raw): Promise<ToolResult> => {
      const parsed = spec.schema.safeParse(raw);
      if (!parsed.success) {
        const detail = parsed.error.issues
          .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
          .join("; ");
        return { modelContent: `Invalid input for ${spec.name}: ${detail}`, isError: true };
      }
      return spec.run(parsed.data);
    },
  };
}
