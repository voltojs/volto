'use client';

import { ReactRenderer } from '@tiptap/react';
import type { ComponentType, Ref } from 'react';
import type { SuggestionProps } from '@tiptap/suggestion';

export interface SuggestionPanelHandle {
  onKeyDown: (event: KeyboardEvent) => boolean;
}

export const SUGGESTION_GAP_PX = 4;
/** top-start anchoring computed at APPLY time (element height is live here),
 *  because the plugin's first computePosition measures the empty panel (h=0)
 *  and the content growth may not retrigger its elementResize observer. */
export function applyTopStartAnchor(
  element: HTMLElement,
  caretRect: DOMRect | null,
  gap: number = SUGGESTION_GAP_PX,
): void {
  if (!caretRect) return;
  element.style.position = 'fixed'; // caretRect is viewport coords
  element.style.left = `${caretRect.left}px`;
  element.style.top = `${Math.max(8, caretRect.top - element.offsetHeight - gap)}px`;
}

/**
 * tiptap Suggestion render 生命周期 → React 面板桥。
 *
 * onStart 用 ReactRenderer 实例化面板并把元素交给 props.mount()（v3 托管
 * 挂载：插件负责 append 到 body、floating-ui 光标锚定、滚动/resize 跟随、
 * 外部点击关闭）；onUpdate 重灌 props（getProps 从 ref 取最新 suggestion
 * 状态）；onKeyDown 委托面板的 imperative handle；onExit 必须调用 mount
 * 返回的 unmount 并 destroy renderer（文档明确：否则泄漏监听器、DOM 残留）。
 */
export function createSuggestionPopup<P extends object>(options: {
  Panel: ComponentType<P & { ref?: Ref<SuggestionPanelHandle> }>;
  getProps: () => P;
  onOpenChange?: (open: boolean) => void;
}) {
  let renderer: ReactRenderer<SuggestionPanelHandle, P> | null = null;
  let detach: (() => void) | null = null;

  return {
    onStart: (props: SuggestionProps) => {
      options.onOpenChange?.(true);
      renderer = new ReactRenderer<SuggestionPanelHandle, P>(options.Panel, {
        editor: props.editor,
        props: options.getProps(),
      });
      // 就地捕获元素引用：闭包内读可变的 renderer 变量不会被 TS 收窄（可空联合
      // 且 onExit 有再赋值）。onPosition 接管插件默认 style 写入路径——首次
      // computePosition 量到的是空面板（h=0），top-start 会把面板锚到光标下方
      // 压住编辑器；改为每次 APPLY 时按实时 caret rect + 实时 offsetHeight 锚定
      // （autoUpdate 在滚动/resize 时持续重调 onPosition，锚定保持活性）。
      const element = renderer.element;
      detach = props.mount(element, {
        onPosition: () => applyTopStartAnchor(element, props.clientRect?.() ?? null),
      });
    },
    onUpdate: () => {
      renderer?.updateProps(options.getProps());
    },
    onKeyDown: ({ event }: { event: KeyboardEvent }) =>
      renderer?.ref?.onKeyDown(event) ?? false,
    onExit: () => {
      options.onOpenChange?.(false);
      detach?.();
      detach = null;
      renderer?.destroy();
      renderer = null;
    },
  };
}
