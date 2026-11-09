/**
 * Swallows the click that follows a completed drag.
 *
 * A drag ends with a pointerup, and the browser still dispatches a `click`
 * right after it — which would open the session or toggle the workspace the
 * user just dragged. The flag therefore has to expire on its own: a keyboard
 * drop never synthesises a row click, and a flag that waited for one would
 * swallow the user's next legitimate click instead.
 */
export interface ClickSuppressor {
  /** Call from the drag-end handler. */
  suppress(): void;
  /** True when this click belongs to the drag that just ended. */
  consume(): boolean;
}

export function createClickSuppressor(): ClickSuppressor {
  let suppressed = false;
  return {
    suppress() {
      suppressed = true;
      // Runs after the synchronously-dispatched click, so the ordinary path
      // (drag → click → suppressed) is not affected.
      setTimeout(() => {
        suppressed = false;
      }, 0);
    },
    consume() {
      if (!suppressed) return false;
      suppressed = false;
      return true;
    },
  };
}