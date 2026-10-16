import { describe, it, expect } from "vitest";
import { planImageOffload, renderImagePreservedMarker } from "../compaction-image-offload.js";
import { extractBlockText } from "../text-extract.js";
import type { ContentBlock, Message } from "../state.js";

// ── builders ────────────────────────────────────────────────────────────────

type ImageSource =
  | { type: "base64"; data: string; mediaType: string }
  | { type: "ref"; id: string; mediaType: string };

function image(source: ImageSource, dims?: { width?: number; height?: number }): ContentBlock {
  // Runtime tool results do carry inline base64 image blocks even though
  // core's ImageContent types the source as ref-only; tests mirror that.
  return { type: "image", source, ...dims } as ContentBlock;
}

function refImage(id: string, dims?: { width?: number; height?: number }): ContentBlock {
  return image({ type: "ref", id, mediaType: "image/png" }, dims);
}

function b64Image(data = "AAAA", dims?: { width?: number; height?: number }): ContentBlock {
  return image({ type: "base64", data, mediaType: "image/png" }, dims);
}

function userMsg(id: string, content: ContentBlock[]): Message {
  return { id, role: "user", content };
}

function toolMsg(id: string, toolUseId: string, content: ContentBlock[]): Message {
  return {
    id,
    role: "tool",
    content: [{ type: "tool_result", toolUseId, content } as unknown as ContentBlock],
  } as Message;
}

// ── dual-path split ─────────────────────────────────────────────────────────

describe("planImageOffload — dual-path split (F-023)", () => {
  it("splits base64 sources into toOffload and keeps ref sources out of it", () => {
    const replaced = [userMsg("m1", [refImage("a1"), b64Image("AAAA")])];
    const plan = planImageOffload(replaced, { maxImages: 4 });

    expect(plan.toOffload).toHaveLength(1);
    expect(plan.toOffload[0]).toMatchObject({
      messageId: "m1",
      blockIndex: 1,
      source: { type: "base64", data: "AAAA", mediaType: "image/png" },
    });
    expect(plan.preserved).toHaveLength(2);
    expect(plan.droppedPlaceholders).toBe("");
  });

  it("preserved keeps an existing ref block's id verbatim", () => {
    const replaced = [userMsg("m1", [refImage("a1", { width: 10, height: 20 })])];
    const plan = planImageOffload(replaced, { maxImages: 4 });

    expect(plan.toOffload).toHaveLength(0);
    expect(plan.preserved).toEqual([
      {
        type: "image",
        source: { type: "ref", id: "a1", mediaType: "image/png" },
        width: 10,
        height: 20,
      },
    ]);
  });

  it("preserved emits a ref-shaped block with the placeholder id 'pending' for inline base64 images", () => {
    const replaced = [userMsg("m1", [b64Image("QUJD", { width: 5, height: 6 })])];
    const plan = planImageOffload(replaced, { maxImages: 4 });

    expect(plan.preserved).toEqual([
      {
        type: "image",
        source: { type: "ref", id: "pending", mediaType: "image/png" },
        width: 5,
        height: 6,
      },
    ]);
  });

  it("records messageId and blockIndex (index within the containing array) for every candidate", () => {
    const replaced = [
      userMsg("m1", [b64Image("AA"), b64Image("BB")]),
      toolMsg("m2", "t1", [b64Image("CC")]),
    ];
    const plan = planImageOffload(replaced, { maxImages: 10 });

    expect(plan.toOffload.map((c) => [c.messageId, c.blockIndex])).toEqual([
      ["m1", 0],
      ["m1", 1],
      ["m2", 0],
    ]);
  });
});

// ── nested tool_result collection ───────────────────────────────────────────

describe("planImageOffload — nested tool_result collection", () => {
  it("collects image blocks nested inside tool_result content arrays", () => {
    const replaced = [
      toolMsg("m1", "t1", [
        { type: "text", text: "result" },
        refImage("a9"),
        b64Image("DD"),
      ]),
    ];
    const plan = planImageOffload(replaced, { maxImages: 4 });

    expect(plan.toOffload.map((c) => [c.messageId, c.blockIndex])).toEqual([["m1", 2]]);
    expect(plan.preserved).toHaveLength(2);
  });

  it("collects top-level and nested images in one pass, order intact", () => {
    const replaced = [
      userMsg("m1", [b64Image("AA")]),
      toolMsg("m2", "t1", [b64Image("BB")]),
    ];
    const plan = planImageOffload(replaced, { maxImages: 4 });

    expect(plan.toOffload.map((c) => c.source.type === "base64" && c.source.data)).toEqual([
      "AA",
      "BB",
    ]);
  });
});

// ── cap (Review Focus 2) ────────────────────────────────────────────────────

describe("planImageOffload — cap keeps exactly N, drops the OLDEST as placeholder", () => {
  it("keeps exactly N and drops the oldest when there are N+1 images", () => {
    const replaced = [
      userMsg("m1", [refImage("old"), refImage("mid"), refImage("new")]),
    ];
    const plan = planImageOffload(replaced, { maxImages: 2 });

    expect(plan.preserved).toHaveLength(2);
    expect(plan.preserved[0]).toMatchObject({ source: { id: "mid" } });
    expect(plan.preserved[1]).toMatchObject({ source: { id: "new" } });
    expect(plan.droppedPlaceholders).toBe("[image: image/png]");
  });

  it("keeps exactly N and drops the N oldest joined in original order", () => {
    const replaced = [
      userMsg("m1", [refImage("i1"), refImage("i2"), refImage("i3"), refImage("i4")]),
    ];
    const plan = planImageOffload(replaced, { maxImages: 2 });

    expect(plan.preserved.map((b) => (b.type === "image" ? b.source.id : ""))).toEqual([
      "i3",
      "i4",
    ]);
    expect(plan.droppedPlaceholders).toBe("[image: image/png]\n[image: image/png]");
  });

  it("keeps all images when the count is at or below the cap", () => {
    const replaced = [userMsg("m1", [refImage("i1"), refImage("i2")])];
    const plan = planImageOffload(replaced, { maxImages: 2 });

    expect(plan.preserved).toHaveLength(2);
    expect(plan.droppedPlaceholders).toBe("");
  });

  it("offloads only the base64 candidates that survive the cap (dropped bytes stay unoffloaded)", () => {
    const replaced = [
      userMsg("m1", [b64Image("DROP"), b64Image("KEEP"), refImage("r1")]),
    ];
    const plan = planImageOffload(replaced, { maxImages: 2 });

    expect(plan.toOffload).toHaveLength(1);
    expect(plan.toOffload[0]).toMatchObject({
      source: { type: "base64", data: "KEEP" },
    });
    expect(plan.droppedPlaceholders).toBe("[image: image/png]");
  });
});

// ── original order ──────────────────────────────────────────────────────────

describe("planImageOffload — original order", () => {
  it("preserves span order across messages in preserved and toOffload", () => {
    const replaced = [
      userMsg("m1", [b64Image("AA", { width: 1, height: 1 }), refImage("r1")]),
      userMsg("m2", [b64Image("BB")]),
    ];
    const plan = planImageOffload(replaced, { maxImages: 10 });

    expect(plan.preserved.map((b) => (b.type === "image" ? b.source.id : ""))).toEqual([
      "pending",
      "r1",
      "pending",
    ]);
    expect(plan.toOffload.map((c) => c.messageId)).toEqual(["m1", "m2"]);
  });
});

// ── empty span ──────────────────────────────────────────────────────────────

describe("planImageOffload — empty span", () => {
  it("returns an all-empty plan for an empty message list", () => {
    expect(planImageOffload([], { maxImages: 4 })).toEqual({
      toOffload: [],
      preserved: [],
      droppedPlaceholders: "",
    });
  });

  it("returns an all-empty plan when the span has messages but no images", () => {
    const replaced: Message[] = [userMsg("m1", [{ type: "text", text: "hello" }])];
    expect(planImageOffload(replaced, { maxImages: 4 })).toEqual({
      toOffload: [],
      preserved: [],
      droppedPlaceholders: "",
    });
  });
});

// ── maxImages <= 0 fallback ─────────────────────────────────────────────────

describe("planImageOffload — maxImages <= 0 falls back to today's behavior", () => {
  const cases: Array<{ name: string; maxImages: number }> = [
    { name: "zero", maxImages: 0 },
    { name: "negative", maxImages: -1 },
  ];

  it.each(cases)("$name: toOffload empty, preserved empty, all placeholders", ({ maxImages }) => {
    const replaced = [
      userMsg("m1", [b64Image("AA", { width: 8, height: 8 }), refImage("r1")]),
    ];
    const plan = planImageOffload(replaced, { maxImages });

    expect(plan.toOffload).toEqual([]);
    expect(plan.preserved).toEqual([]);
    expect(plan.droppedPlaceholders).toBe("[image: 8x8 image/png]\n[image: image/png]");
  });
});

// ── placeholder / marker verbatim ───────────────────────────────────────────

describe("placeholders and marker — verbatim formats", () => {
  const cases: Array<{
    name: string;
    dims?: { width?: number; height?: number };
    expected: string;
  }> = [
    { name: "with both dims", dims: { width: 800, height: 600 }, expected: "[image: 800x600 image/png]" },
    { name: "without dims", expected: "[image: image/png]" },
    { name: "with only width (dims segment omitted)", dims: { width: 800 }, expected: "[image: image/png]" },
  ];

  it.each(cases)("dropped placeholder $name", ({ dims, expected }) => {
    // The dims image is OLDER (dropped), the plain one survives the cap.
    const replaced = [userMsg("m1", [refImage("r1", dims), b64Image("AA")])];
    const plan = planImageOffload(replaced, { maxImages: 1 });

    expect(plan.droppedPlaceholders).toBe(expected);
    // Contract: identical to what extractBlockText renders for the same block.
    expect(plan.droppedPlaceholders).toBe(extractBlockText(refImage("r1", dims)));
  });

  const markerCases: Array<{
    name: string;
    meta: { width?: number; height?: number; mediaType: string };
    expected: string;
  }> = [
    {
      name: "with both dims",
      meta: { width: 800, height: 600, mediaType: "image/png" },
      expected: "[image preserved from compressed conversation: 800x600 image/png]",
    },
    {
      name: "without dims",
      meta: { mediaType: "image/jpeg" },
      expected: "[image preserved from compressed conversation: image/jpeg]",
    },
    {
      name: "with only height (dims segment omitted)",
      meta: { height: 600, mediaType: "image/webp" },
      expected: "[image preserved from compressed conversation: image/webp]",
    },
  ];

  it.each(markerCases)("renderImagePreservedMarker $name", ({ meta, expected }) => {
    expect(renderImagePreservedMarker(meta)).toBe(expected);
  });
});
