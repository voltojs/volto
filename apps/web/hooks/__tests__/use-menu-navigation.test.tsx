// apps/web/hooks/__tests__/use-menu-navigation.test.tsx
import { describe, it, expect, vi } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useMenuNavigation } from '../use-menu-navigation';

const KEY = (key: string) => ({ key });

describe('useMenuNavigation', () => {
  it('ArrowDown/ArrowUp 循环移动', () => {
    const { result } = renderHook(() =>
      useMenuNavigation({ itemCount: 3, enabled: true, onSelect: vi.fn() }),
    );
    act(() => void result.current.handleKeyDown(KEY('ArrowDown')));
    expect(result.current.activeIndex).toBe(1);
    act(() => void result.current.handleKeyDown(KEY('ArrowDown')));
    act(() => void result.current.handleKeyDown(KEY('ArrowDown')));
    expect(result.current.activeIndex).toBe(0); // 循环回 0
    act(() => void result.current.handleKeyDown(KEY('ArrowUp')));
    expect(result.current.activeIndex).toBe(2); // 循环回尾
  });

  it('Enter 调 onSelect 且恒消费（空列表也吞咽）', () => {
    const onSelect = vi.fn();
    const { result, rerender } = renderHook(
      ({ count }) => useMenuNavigation({ itemCount: count, enabled: true, onSelect }),
      { initialProps: { count: 2 } },
    );
    expect(result.current.handleKeyDown(KEY('Enter'))).toBe(true);
    expect(onSelect).toHaveBeenCalledWith(0);
    rerender({ count: 0 });
    expect(result.current.handleKeyDown(KEY('Enter'))).toBe(true); // 吞咽
    expect(onSelect).toHaveBeenCalledTimes(1);
  });

  it('Tab 仅在提供 onTab 时消费', () => {
    const onTab = vi.fn();
    const without = renderHook(() => useMenuNavigation({ itemCount: 1, enabled: true, onSelect: vi.fn() }));
    expect(without.result.current.handleKeyDown(KEY('Tab'))).toBe(false);
    const withTab = renderHook(() => useMenuNavigation({ itemCount: 1, enabled: true, onSelect: vi.fn(), onTab }));
    expect(withTab.result.current.handleKeyDown(KEY('Tab'))).toBe(true);
    expect(onTab).toHaveBeenCalledWith(0);
  });

  it('Escape 不消费（插件原生 dismiss）', () => {
    const { result } = renderHook(() => useMenuNavigation({ itemCount: 1, enabled: true, onSelect: vi.fn() }));
    expect(result.current.handleKeyDown(KEY('Escape'))).toBe(false);
  });

  it('enabled=false 一律放行', () => {
    const { result } = renderHook(() =>
      useMenuNavigation({ itemCount: 2, enabled: false, onSelect: vi.fn(), onTab: vi.fn() }),
    );
    expect(result.current.handleKeyDown(KEY('ArrowDown'))).toBe(false);
    expect(result.current.handleKeyDown(KEY('Enter'))).toBe(false);
  });

  it('itemCount 收缩时索引钳制回 0', () => {
    const { result, rerender } = renderHook(
      ({ count }) => useMenuNavigation({ itemCount: count, enabled: true, onSelect: vi.fn() }),
      { initialProps: { count: 3 } },
    );
    act(() => void result.current.handleKeyDown(KEY('ArrowDown')));
    act(() => void result.current.handleKeyDown(KEY('ArrowDown')));
    expect(result.current.activeIndex).toBe(2);
    rerender({ count: 1 });
    expect(result.current.activeIndex).toBe(0);
  });
});
