/**
 * Read pixel dimensions straight from an image's header.
 *
 * Header parsing only — no decoding library. Dimensions feed token
 * estimation, so a wrong guess is worse than no guess: every unrecognized
 * shape returns undefined and lets the caller fall back to a conservative
 * constant.
 */
export function readImageDimensions(bytes: Buffer): { width: number; height: number } | undefined {
  return readPng(bytes) ?? readJpeg(bytes);
}

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function readPng(b: Buffer): { width: number; height: number } | undefined {
  // Signature (8 bytes) + IHDR length/type (8 bytes), then width and height.
  if (b.length < 24 || !b.subarray(0, 8).equals(PNG_SIGNATURE)) return undefined;
  if (b.subarray(12, 16).toString("ascii") !== "IHDR") return undefined;
  return { width: b.readUInt32BE(16), height: b.readUInt32BE(20) };
}

function readJpeg(b: Buffer): { width: number; height: number } | undefined {
  if (b.length < 4 || b[0] !== 0xff || b[1] !== 0xd8) return undefined;
  let offset = 2;
  while (offset + 9 < b.length) {
    if (b[offset] !== 0xff) return undefined;
    const marker = b[offset + 1];
    if (marker === undefined) return undefined;
    // SOF0..SOF15 carry the frame header; DHT/JPG/DAC share the range but not the layout.
    const isFrameHeader =
      marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
    if (isFrameHeader) {
      return { height: b.readUInt16BE(offset + 5), width: b.readUInt16BE(offset + 7) };
    }
    offset += 2 + b.readUInt16BE(offset + 2);
  }
  return undefined;
}
