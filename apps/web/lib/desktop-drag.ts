/**
 * Window dragging for the desktop host's overlay title bar.
 *
 * Markup uses Tauri's official `data-tauri-drag-region` attribute. The
 * built-in drag script is not injected into the remote gateway page in this
 * setup, so this capture-phase handler calls the same official command
 * (`plugin:window|start_dragging`). Capture runs before the built-in bubble
 * listener, so there is still exactly one drag start if the script appears.
 */
interface TauriInternals {
  invoke(command: string, args?: Record<string, unknown>): Promise<unknown>;
}

const INTERACTIVE =
  'button, a, input, textarea, select, label, summary, [role="button"], [role="link"], [role="menuitem"], [role="tab"], [role="checkbox"], [role="radio"], [role="switch"], [contenteditable="true"]';

function inDragRegion(target: EventTarget | null): boolean {
  return (
    target instanceof HTMLElement &&
    target.closest('[data-tauri-drag-region]') !== null &&
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
    event.stopPropagation();
    void internals
      .invoke('plugin:window|start_dragging')
      .catch((error: unknown) => console.error('start_dragging', error));
  };

  const onDoubleClick = (event: MouseEvent): void => {
    if (!inDragRegion(event.target)) return;
    event.stopPropagation();
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
