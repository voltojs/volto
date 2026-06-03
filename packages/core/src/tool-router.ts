import type { PendingToolCall } from "./state.js";
import type { ToolDefinition, ToolResult, JSONSchema } from "./tool.js";

function missing(value: unknown): boolean {
  return value === undefined || value === null;
}

function typeMatches(schema: JSONSchema | undefined, value: unknown): boolean {
  if (!schema?.type) {
    return true;
  }

  switch (schema.type) {
    case "string":
      return typeof value === "string";
    case "number":
      return typeof value === "number";
    case "boolean":
      return typeof value === "boolean";
    case "object":
      return typeof value === "object" && value !== null && !Array.isArray(value);
    case "array":
      return Array.isArray(value);
    default:
      return true;
  }
}

export function validateToolInput(schema: JSONSchema | undefined, input: unknown): string | null {
  if (!schema) {
    return null;
  }

  if (schema.type === "object" && schema.properties) {
    if (missing(input) || typeof input !== "object" || Array.isArray(input)) {
      return "expected object input";
    }

    const record = input as Record<string, unknown>;
    for (const key of schema.required ?? []) {
      if (missing(record[key])) {
        return `missing required property: ${key}`;
      }
    }

    for (const [key, propertySchema] of Object.entries(schema.properties)) {
      if (!missing(record[key])) {
        if (!typeMatches(propertySchema, record[key])) {
          return `property "${key}" has invalid type`;
        }
      }
    }

    return null;
  }

  if (!typeMatches(schema, input)) {
    return "invalid input type";
  }

  return null;
}

export function filterVisibleTools(tools: ToolDefinition[], availableCapabilities: Set<string>): ToolDefinition[] {
  return tools.filter((tool) => tool.requires.every((capability) => availableCapabilities.has(capability)));
}

export function routeToolCall(
  tools: ToolDefinition[],
  availableCapabilities: Set<string>,
  call: PendingToolCall,
): { tool?: ToolDefinition; result?: ToolResult } {
  const tool = tools.find((definition) => definition.name === call.name);
  if (!tool) {
    return {
      result: {
        modelContent: `Unknown tool: ${call.name}`,
        isError: true,
      },
    };
  }

  for (const capability of tool.requires) {
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

  const validationError = validateToolInput(tool.inputSchema, call.input);
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
