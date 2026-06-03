import type { PendingToolCall, ToolDefinition, ToolResult } from "@agent-core/core";
import type { FileTool } from "./common.js";

function isMissing(value: unknown): boolean {
  return value === undefined || value === null;
}

function validateAgainstSchema(schema: Record<string, unknown> | undefined, value: unknown): string | null {
  if (!schema || typeof schema !== "object") {
    return null;
  }

  if (isMissing(value)) {
    return "value is required";
  }

  const expectedType = schema.type as string | undefined;
  if (expectedType === "object" && (typeof value !== "object" || Array.isArray(value))) {
    return "expected object";
  }
  if (expectedType === "string" && typeof value !== "string") {
    return "expected string";
  }
  if (expectedType === "number" && typeof value !== "number") {
    return "expected number";
  }
  if (expectedType === "boolean" && typeof value !== "boolean") {
    return "expected boolean";
  }
  if (expectedType === "array") {
    if (!Array.isArray(value)) {
      return "expected array";
    }
    const items = schema.items as Record<string, unknown> | undefined;
    if (items) {
      for (const entry of value) {
        const error = validateAgainstSchema(items, entry);
        if (error) {
          return `array item invalid: ${error}`;
        }
      }
    }
  }

  if (expectedType === "object" && schema.properties && typeof value === "object" && !Array.isArray(value)) {
    const objectValue = value as Record<string, unknown>;
    const properties = schema.properties as Record<string, Record<string, unknown>>;
    const required = (schema.required as string[] | undefined) ?? [];

    for (const key of required) {
      if (isMissing(objectValue[key])) {
        return `missing required property: ${key}`;
      }
    }

    for (const [key, propertySchema] of Object.entries(properties)) {
      if (!isMissing(objectValue[key])) {
        const error = validateAgainstSchema(propertySchema, objectValue[key]);
        if (error) {
          return `${key}: ${error}`;
        }
      }
    }
  }

  if (Array.isArray(schema.enum) && !schema.enum.includes(value)) {
    return "value not in enum";
  }

  return null;
}

export function routeToolCall(
  tools: FileTool[],
  availableCapabilities: Set<string>,
  call: PendingToolCall,
  fallbackDefinition: ToolDefinition,
): { tool: FileTool; result?: ToolResult } {
  const tool = tools.find((entry) => entry.definition.name === call.name);
  if (!tool) {
    return {
      tool: { definition: fallbackDefinition, handler: async () => ({ modelContent: "", isError: true }) },
      result: {
        modelContent: `Unknown tool: ${call.name}`,
        isError: true,
      },
    };
  }

  for (const capability of tool.definition.requires) {
    if (!availableCapabilities.has(capability)) {
      return {
        tool,
        result: {
          modelContent: `Tool "${call.name}" is not available: missing capability ${capability}.`,
          isError: true,
        },
      };
    }
  }

  const validationError = validateAgainstSchema(
    tool.definition.inputSchema as Record<string, unknown> | undefined,
    call.input,
  );
  if (validationError) {
    return {
      tool,
      result: {
        modelContent: `Invalid input for tool "${call.name}": ${validationError}`,
        isError: true,
      },
    };
  }

  return { tool };
}
