import { describe, it, expect } from "vitest";
import { filterVisibleTools, CAP_MODEL_VISION } from "../index.js";
import type { ToolDefinition, ResolvedModelInfo } from "../index.js";

const imageProducer: ToolDefinition = {
  name: "some_image_tool",
  description: "produces an image",
  inputSchema: { type: "object" },
  requires: [CAP_MODEL_VISION],
  riskTier: "READ_ONLY",
};
const reader: ToolDefinition = {
  name: "read_file",
  description: "reads a file",
  inputSchema: { type: "object" },
  requires: ["filesystem:read"],
  riskTier: "READ_ONLY",
};

describe("vision capability gating", () => {
  it("pins the capability string so hosts and tools agree", () => {
    expect(CAP_MODEL_VISION).toBe("model:vision");
  });

  it("hides pure image producers when vision is unavailable", () => {
    const visible = filterVisibleTools([imageProducer, reader], new Set(["filesystem:read"]));
    expect(visible.map((t) => t.name)).toEqual(["read_file"]);
  });

  it("keeps mixed tools visible so their text path still works", () => {
    const visible = filterVisibleTools([reader], new Set(["filesystem:read"]));
    expect(visible.map((t) => t.name)).toEqual(["read_file"]);
  });

  it("exposes image producers once vision is granted", () => {
    const visible = filterVisibleTools(
      [imageProducer, reader],
      new Set(["filesystem:read", CAP_MODEL_VISION]),
    );
    expect(visible.map((t) => t.name)).toContain("some_image_tool");
  });
});

describe("ResolvedModelInfo.vision tri-state", () => {
  it("treats absence as unknown, not unavailable", () => {
    const unknown: ResolvedModelInfo = { model: "gateway-mystery" };
    expect(unknown.vision).toBeUndefined();
    // Explicit false is the only value that means "no image input".
    const unsupported: ResolvedModelInfo = { model: "text-only", vision: false };
    expect(unsupported.vision).toBe(false);
    const supported: ResolvedModelInfo = { model: "multimodal", vision: true };
    expect(supported.vision).toBe(true);
  });
});

describe("ResolvedModelInfo.input tri-state", () => {
  it("absence means unknown; only an explicit text-only list gates images", () => {
    const unknown: ResolvedModelInfo = { model: "gateway-mystery" };
    expect(unknown.input).toBeUndefined();

    const textOnly: ResolvedModelInfo = { model: "text-only", input: ["text"] };
    expect(textOnly.input).toEqual(["text"]);
    expect(textOnly.input?.includes("image")).toBe(false);

    const multimodal: ResolvedModelInfo = {
      model: "multi",
      input: ["text", "image"],
    };
    expect(multimodal.input?.includes("image")).toBe(true);
  });

  it("carries pi-ai-shaped inputLimits verbatim", () => {
    const info: ResolvedModelInfo = {
      model: "deepseek-flash",
      inputLimits: {
        images: {
          resize: { maxWidth: 2000, maxHeight: 2000, maxBytes: 4718592, jpegQuality: 80 },
          maxPerMessage: 4,
          maxPerRequest: 8,
        },
        maxRequestBytes: 1024,
      },
    };
    expect(info.inputLimits?.images?.resize?.maxWidth).toBe(2000);
    expect(info.inputLimits?.images?.maxPerRequest).toBe(8);
    expect(info.inputLimits?.maxRequestBytes).toBe(1024);
  });
});
