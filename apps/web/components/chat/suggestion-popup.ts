'use client';

import { ReactRenderer } from '@tiptap/react';
import type { ComponentType, Ref } from 'react';
import type { SuggestionProps } from '@tiptap/suggestion';

export interface SuggestionPanelHandle {
  onKeyDown: (event: KeyboardEvent) => boolean;
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
      detach = props.mount(renderer.element);
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
