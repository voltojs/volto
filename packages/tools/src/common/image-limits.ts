/**
 * Shared image-pipeline limits for tools that emit AttachmentStore-backed
 * image blocks (read_file, read_document). Kept here so both packages share
 * one source of truth for the plan's Global Constraints.
 */

/**
 * Plan Global Constraint: a single image whose base64 payload exceeds 5 MB
 * must be rejected with isError rather than stored or forwarded to the model.
 */
export const MAX_IMAGE_BASE64 = 5 * 1024 * 1024;

/**
 * Plan Global Constraint: when an image's long edge exceeds 1568 px, tools
 * should suggest downscaling (vision token cost scales with pixel area).
 * Advisory only — never auto-resize.
 */
export const IMAGE_LONG_EDGE_SUGGEST_PX = 1568;

/**
 * Advisory note when the long edge exceeds IMAGE_LONG_EDGE_SUGGEST_PX.
 * Returns undefined when dimensions are unknown or within budget.
 */
export function imageDownscaleHint(width?: number, height?: number): string | undefined {
  if (width === undefined || height === undefined) return undefined;
  const longEdge = Math.max(width, height);
  if (longEdge <= IMAGE_LONG_EDGE_SUGGEST_PX) return undefined;
  return `Image long edge is ${longEdge}px (> ${IMAGE_LONG_EDGE_SUGGEST_PX}px); consider downscaling to reduce token cost.`;
}
