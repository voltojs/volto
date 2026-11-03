import { Buffer } from "node:buffer";

export const DEFAULT_PROCESS_BUFFER_BYTES = 256 * 1024;

const OVERFLOW_NOTE_PREFIX = "Earlier output was dropped (";

export interface ProcessBufferRead {
  text: string;
  cursor: string;
  overflowed: boolean;
  droppedBytes: number;
}

export interface ProcessOutputBuffer {
  append(chunk: string): void;
  read(cursor?: string): ProcessBufferRead;
  readonly totalWritten: number;
}

/**
 * Byte-accurate ring buffer. Cursors are decimal totals of bytes ever
 * written; a cursor older than the retained window yields the whole
 * window plus a discard note rather than a silent gap.
 *
 * `overflowed` is per-read: a full-window snapshot after any eviction,
 * or a cursor read that fell out of the retained window. A clean
 * incremental delta still inside the window reports overflowed=false
 * even when history was dropped earlier.
 */
export function createProcessOutputBuffer(
  capacityBytes: number = DEFAULT_PROCESS_BUFFER_BYTES,
): ProcessOutputBuffer {
  const capacity = Math.max(1, capacityBytes);
  /** Chunks still retained, in write order. */
  const retained: Buffer[] = [];
  let retainedBytes = 0;
  let droppedBytes = 0;
  /** Total bytes ever appended — also the high-water cursor. */
  let totalWritten = 0;
  /** Absolute byte offset of retained[0] within the full history. */
  let retainedStart = 0;

  function evict(): void {
    while (retainedBytes > capacity && retained.length > 0) {
      const head = retained[0]!;
      if (retained.length === 1) {
        // Single chunk still over capacity: keep only its tail.
        const excess = retainedBytes - capacity;
        retained[0] = head.subarray(excess);
        retainedBytes -= excess;
        retainedStart += excess;
        droppedBytes += excess;
        break;
      }
      retained.shift();
      retainedBytes -= head.length;
      retainedStart += head.length;
      droppedBytes += head.length;
    }
  }

  function append(chunk: string): void {
    const buf = Buffer.from(chunk, "utf8");
    if (buf.length === 0) return;
    retained.push(buf);
    retainedBytes += buf.length;
    totalWritten += buf.length;
    evict();
  }

  function read(fromCursor?: string): ProcessBufferRead {
    const all = Buffer.concat(retained);
    let text: string;
    let missedWindow = false;
    if (fromCursor === undefined) {
      text = all.toString("utf8");
    } else {
      const parsed = Number.parseInt(fromCursor, 10);
      const cursorBytes = Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;
      // Client already consumed [0, cursorBytes). Anything before
      // retainedStart is gone from the ring.
      missedWindow = cursorBytes < retainedStart;
      const sliceFrom = Math.max(0, cursorBytes - retainedStart);
      // Slice on the byte buffer before decoding so a multi-byte
      // character is never split by a character-index approximation.
      text = all.subarray(sliceFrom).toString("utf8");
    }
    // Per-read overflow: full snapshots disclose any eviction; cursor
    // reads only overflow when the cursor fell out of the window.
    const overflowed =
      missedWindow || (fromCursor === undefined && droppedBytes > 0);
    const note = overflowed
      ? `${OVERFLOW_NOTE_PREFIX}${droppedBytes} bytes)\n`
      : "";
    return {
      text: note + text,
      cursor: String(totalWritten),
      overflowed,
      droppedBytes,
    };
  }

  return {
    append,
    read,
    get totalWritten() {
      return totalWritten;
    },
  };
}
