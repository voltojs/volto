/**
 * Window dragging for the desktop host's overlay title bar.
 *
 * Tauri's built-in drag script is not injected into the remote gateway page,
 * so the shell installs its own listener and calls the window plugin command
 * the main-window capability allows (`remote` URLs, any port). Interactive
 * elements are excluded so header buttons stay clickable.
 */
interface TauriInternals {
  invoke(command: string, args?: Record<string, unknown>): Promise<unknown>;
}

const INTERACTIVE =
  'button, a, input, textarea, select, [role="button"], [contenteditable="true"]';

function inDragRegion(target: EventTarget | null): boolean {
  return (
    target instanceof HTMLElement &&
    target.closest('[data-volto-drag]') !== null &&
    target.closest(INTERACTIVE) === null
  );
}

export function installDesktopDrag(): () => void {
  if (typeof document === 'undefined') return () => {};
  if (document.documentElement.dataset.voltoShell !== 'desktop') return () => {};
  const internals = (
    window as unknown as { __TAURI_INTERNALS__?: TauriInternals }
  ).__TAURI_INTERNALS__;
  if (internals === undefined) return () => {};

  const onMouseDown = (event: MouseEvent): void => {
    if (event.button !== 0 || !inDragRegion(event.target)) return;
    event.preventDefault();
    void internals
      .invoke('plugin:window|start_dragging')
      .catch((error: unknown) => console.error('start_dragging', error));
  };

  const onDoubleClick = (event: MouseEvent): void => {
    if (!inDragRegion(event.target)) return;
    void internals
      .invoke('plugin:window|internal_toggle_maximize')
      .catch((error: unknown) => console.error('toggle_maximize', error));
  };

  document.addEventListener('mousedown', onMouseDown, true);
  document.addEventListener('dblclick', onDoubleClick, true);
  (window as unknown as { __VOLTO_DRAG_READY__?: boolean }).__VOLTO_DRAG_READY__ =
    true;

  return () => {
    document.removeEventListener('mousedown', onMouseDown, true);
    document.removeEventListener('dblclick', onDoubleClick, true);
  };
}
