'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

export interface MenuKeyEvent {
  key: string;
}

export interface UseMenuNavigationOptions {
  itemCount: number;
  enabled: boolean;
  /** Enter（itemCount > 0 时）。 */
  onSelect: (index: number) => void;
  /** Tab（itemCount > 0 时）。不提供则 Tab 放行。 */
  onTab?: (index: number) => void;
}

export interface MenuNavigation {
  activeIndex: number;
  setActiveIndex: (index: number) => void;
  /** 返回 true 表示按键已被面板消费。 */
  handleKeyDown: (event: MenuKeyEvent) => boolean;
  reset: () => void;
}

/**
 * Roving-index keyboard navigation for suggestion panels. Callers own the
 * trigger-to-panel key routing; this hook only owns the index and the
 * consume/decay semantics. Enter is ALWAYS consumed while enabled — with an
 * empty list it swallows the key so a panel-open Enter can never insert a
 * paragraph into the single-paragraph editor.
 */
export function useMenuNavigation({
  itemCount,
  enabled,
  onSelect,
  onTab,
}: UseMenuNavigationOptions): MenuNavigation {
  const [activeIndex, setActiveIndexState] = useState(0);
  const activeIndexRef = useRef(0);
  const itemCountRef = useRef(itemCount);
  const enabledRef = useRef(enabled);
  const onSelectRef = useRef(onSelect);
  const onTabRef = useRef(onTab);

  // Mirror the latest props into the refs after every commit. (The planned
  // render-phase assignment is forbidden by react-hooks/refs; effect-phase
  // mirroring is the sanctioned form and is equivalent for key handling:
  // refs start correct from useRef initializers, and React flushes pending
  // effects before the next discrete keydown reaches a handler.)
  useEffect(() => {
    itemCountRef.current = itemCount;
    enabledRef.current = enabled;
    onSelectRef.current = onSelect;
    onTabRef.current = onTab;
  });

  const setActiveIndex = useCallback((index: number) => {
    activeIndexRef.current = index;
    setActiveIndexState(index);
  }, []);

  useEffect(() => {
    if (itemCount === 0 || activeIndexRef.current >= itemCount) {
      setActiveIndex(0);
    }
  }, [itemCount, setActiveIndex]);

  const handleKeyDown = useCallback(
    (event: MenuKeyEvent): boolean => {
      if (!enabledRef.current) return false;
      const n = itemCountRef.current;
      switch (event.key) {
        case 'ArrowDown':
          if (n === 0) return false;
          setActiveIndex((activeIndexRef.current + 1) % n);
          return true;
        case 'ArrowUp':
          if (n === 0) return false;
          setActiveIndex((activeIndexRef.current - 1 + n) % n);
          return true;
        case 'Enter':
          if (n > 0) onSelectRef.current(activeIndexRef.current);
          return true;
        case 'Tab':
          if (onTabRef.current && n > 0) onTabRef.current(activeIndexRef.current);
          return Boolean(onTabRef.current);
        default:
          return false;
      }
    },
    [setActiveIndex],
  );

  const reset = useCallback(() => setActiveIndex(0), [setActiveIndex]);

  return { activeIndex, setActiveIndex, handleKeyDown, reset };
}
