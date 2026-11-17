import { useEffect, useState } from "react";

import type { ShellState } from "@shared/gateway";

/**
 * Mirror of the main process state. The initial read and the push channel are
 * both needed: a window that mounts after the last push must still get a
 * state, and a live one must not miss the next.
 */
export function useShellState(): ShellState | null {
  const [state, setState] = useState<ShellState | null>(null);

  useEffect(() => {
    const api = window.voltoShell;
    if (api === undefined) return;
    let alive = true;
    void api
      .getState()
      .then((next) => {
        if (alive) setState(next);
      })
      .catch(() => undefined);
    const unsubscribe = api.onState((next) => setState(next));
    return () => {
      alive = false;
      unsubscribe();
    };
  }, []);

  return state;
}