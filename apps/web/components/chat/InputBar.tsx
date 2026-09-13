'use client';

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
  type ReactNode,
} from 'react';
import { ArrowUp, Square } from 'lucide-react';
import { EditorContent, useEditor, type Editor } from '@tiptap/react';
import { Extension } from '@tiptap/core';
import { Document } from '@tiptap/extension-document';
import { Paragraph } from '@tiptap/extension-paragraph';
import { Text } from '@tiptap/extension-text';
import { HardBreak } from '@tiptap/extension-hard-break';
import { Mention } from '@tiptap/extension-mention';
import { Placeholder, UndoRedo } from '@tiptap/extensions';
import { Suggestion, type SuggestionProps } from '@tiptap/suggestion';
import { PluginKey } from '@tiptap/pm/state';
import { Button } from '@/components/ui/button';
import { matchActionCommand, type CommandItem, type InputAction } from '@/lib/input-commands';
import { SlashPanel } from './SlashPanel';
import { createSuggestionPopup } from './suggestion-popup';

/** 单段落文档：Enter 永远是"发送"，换行走 Shift+Enter（HardBreak）。 */
const SingleParagraphDocument = Document.extend({ content: 'paragraph' });

/** @文件 mention 节点。Task 11 会把 suggestion 配置换成面板接线；
 *  这里先给最小占位配置，避免默认 suggestion 的意外行为。 */
const FileMention = Mention.configure({
  HTMLAttributes: { class: 'file-mention-chip' },
  renderText: ({ node }) => `@${node.attrs.label ?? node.attrs.id}`,
  suggestion: { char: '@', items: () => [] },
});

export interface InputBarProps {
  onSubmit?: (message: string) => void;
  disabled?: boolean;
  placeholder?: string;
  /** Controls on the left of the toolbar (permission / project pickers). */
  toolbar?: ReactNode;
  /** Controls immediately left of the send button (context meter, model picker). */
  trailing?: ReactNode;
  /**
   * True while a turn is streaming: the send button becomes a stop button.
   * Note this is independent of `disabled` — the stop button stays clickable
   * while the editor is locked.
   */
  isGenerating?: boolean;
  /** Invoked by the stop button. Omit to keep the send button while generating. */
  onStop?: () => void;
  /** 绑定项目 id：@ 文件面板与 skills 目录数据源。null/undefined = 未绑定。 */
  projectId?: string | null;
  /** 动作命令（/clear）在前端拦截后的执行入口。 */
  onInputAction?: (action: InputAction) => void;
  /** 编辑器实例注入口（测试与高级用法）。 */
  onEditorReady?: (editor: Editor) => void;
}

export function InputBar({
  onSubmit,
  disabled,
  placeholder,
  toolbar,
  trailing,
  isGenerating,
  onStop,
  projectId,
  onInputAction,
  onEditorReady,
}: InputBarProps) {
  const [isEmpty, setIsEmpty] = useState(true);

  // 编辑器实例只创建一次，回调经 ref 读取最新 props，闭包不过期。
  // react-hooks v7 的 refs 规则禁止在 render 期写 ref，镜像挪进无依赖
  // effect（每次 render 后运行；事件回调的读取时机都在其之后，时序等价）。
  const onSubmitRef = useRef(onSubmit);
  const onInputActionRef = useRef(onInputAction);
  const disabledRef = useRef(disabled);
  const placeholderRef = useRef(placeholder);
  const projectIdRef = useRef(projectId);
  const onEditorReadyRef = useRef(onEditorReady);
  // tiptap v3 的 `create` 事件在 Editor.mount() 的 setTimeout(0) 里异步发出，
  // 仅靠 onCreate 注入编辑器会晚一个宏任务（onEditorReady 的契约是拿到"活
  // 实例"即可立即使用，测试里同步读取 editor 就会踩空）。改为实例首次可用
  // 时同步发一次；onCreate 稍后的发射按实例身份去重，保证每实例恰好一次。
  const emittedEditorRef = useRef<Editor | null>(null);

  // 面板打开时 editorProps.handleKeyDown 必须整体放行：prosemirror-view 的
  // someProp 先查 editorProps 再查插件，这里若无条件消费 Enter，面板永远
  // 收不到按键。Task 10/11 的 suggestion onStart/onExit 负责翻转它。
  const panelOpenRef = useRef(false);
  const editorRef = useRef<Editor | null>(null);
  // 当前活跃 suggestion 的状态（query/command 等），由 render 生命周期写入、
  // 面板 props 经 getProps 惰性读取——保证面板永远拿到最新值。
  const slashPropsRef = useRef<SuggestionProps | null>(null);

  // ref 读取/写入都发生在 tiptap 插件的惰性回调里（事务/按键时才调用），并非
  // render 期执行；react-hooks v7 编译器规则无法识别该时序：react-hooks/refs
  // 误报后整个组件跳过编译，连带 preserve-manual-memoization 报 memo 丢失。
  // 两条均为 scoped 豁免，与下方 Placeholder 的豁免同型（Task 9 先例）。
  // eslint-disable-next-line react-hooks/preserve-manual-memoization
  const slashExtension = useMemo(
    () =>
      // eslint-disable-next-line react-hooks/refs
      Extension.create({
        name: 'slashCommandSuggestion',
        addProseMirrorPlugins() {
          const popup = createSuggestionPopup({
            Panel: SlashPanel,
            getProps: () => ({
              query: slashPropsRef.current?.query ?? '',
              projectId: projectIdRef.current ?? null,
              onSelect: (item: CommandItem) => {
                slashPropsRef.current?.command({ replacement: `/${item.name} ` });
              },
            }),
            onOpenChange: (open) => {
              panelOpenRef.current = open;
            },
          });
          return [
            Suggestion({
              editor: this.editor,
              pluginKey: new PluginKey('slash-command-suggestion'),
              char: '/',
              // 仅文档第一个字符触发（spec §4 verbatim）
              allow: ({ range }) => range.from === 1,
              placement: 'top-start',
              items: () => [], // 数据由 SlashPanel 自取（模块缓存秒开），这里保持同步空数组避免双取
              command: ({ editor: instance, range, props }) => {
                instance.chain().focus().insertContentAt(range, props.replacement).run();
              },
              render: () => {
                // 让 popup 生命周期与 SuggestionProps 状态对齐：onStart/onUpdate
                // 时把 props 记进 ref（面板读最新 query；onSelect 需要 command）。
                return {
                  onStart: (props) => {
                    slashPropsRef.current = props;
                    popup.onStart(props);
                  },
                  onUpdate: (props) => {
                    slashPropsRef.current = props;
                    popup.onUpdate();
                  },
                  onKeyDown: popup.onKeyDown,
                  onExit: () => {
                    slashPropsRef.current = null;
                    popup.onExit();
                  },
                };
              },
            }),
          ];
        },
      }),
    [],
  );

  const submit = useCallback(() => {
    const editor = editorRef.current;
    if (!editor || disabledRef.current) return;
    const text = editor.getText({ blockSeparator: '\n' }).trim();
    if (!text) return;
    const action = matchActionCommand(text);
    if (action) {
      onInputActionRef.current?.(action.action);
    } else {
      onSubmitRef.current?.(text);
    }
    editor.commands.clearContent(true);
  }, []);
  const submitRef = useRef(submit);

  useEffect(() => {
    onSubmitRef.current = onSubmit;
    onInputActionRef.current = onInputAction;
    disabledRef.current = disabled;
    placeholderRef.current = placeholder;
    projectIdRef.current = projectId;
    onEditorReadyRef.current = onEditorReady;
    submitRef.current = submit;
  });

  const editor = useEditor({
    extensions: [
      SingleParagraphDocument,
      slashExtension,
      Paragraph,
      Text,
      HardBreak,
      FileMention,
      UndoRedo,
      // ref 读取发生在 tiptap 装饰阶段的惰性回调里，并非 render 期执行；
      // react-hooks/refs 无法识别该时序，此处 scoped 豁免。
      // eslint-disable-next-line react-hooks/refs
      Placeholder.configure({
        placeholder: () => placeholderRef.current ?? '描述你想要构建的内容…',
      }),
    ],
    editable: !(disabled ?? false),
    editorProps: {
      attributes: {
        class: 'tiptap-input max-h-48 min-h-11 overflow-y-auto px-3.5 py-3 text-sm outline-none',
        'data-testid': 'input-editor',
      },
      handleKeyDown: (_view, event) => {
        if (panelOpenRef.current) return false;
        if (event.key === 'Enter' && event.shiftKey) {
          event.preventDefault();
          editorRef.current?.chain().focus().setHardBreak().run();
          return true;
        }
        if (event.key === 'Enter' && !event.isComposing) {
          event.preventDefault();
          submitRef.current();
          return true;
        }
        return false;
      },
    },
    onCreate: ({ editor: instance }) => {
      editorRef.current = instance;
      if (emittedEditorRef.current !== instance) {
        emittedEditorRef.current = instance;
        onEditorReady?.(instance);
      }
    },
    onDestroy: () => {
      editorRef.current = null;
    },
    onUpdate: ({ editor: instance }) => setIsEmpty(instance.isEmpty),
  });

  // 编辑器实例首次可用即注入（覆盖 onCreate 异步发射的间隙）；effect 声明
  // 必须在 useEditor 之后——deps 数组引用 editor，前置会触发 TDZ。
  useEffect(() => {
    if (!editor || emittedEditorRef.current === editor) return;
    emittedEditorRef.current = editor;
    editorRef.current = editor;
    onEditorReadyRef.current?.(editor);
  }, [editor]);

  useEffect(() => {
    editor?.setEditable(!(disabled ?? false));
  }, [editor, disabled]);

  const handleSubmit = (e: FormEvent) => {
    e.preventDefault();
    submit();
  };

  const showStop = Boolean(isGenerating && onStop);

  return (
    <form onSubmit={handleSubmit} className="mx-auto w-full max-w-3xl px-6 pb-4">
      <div className="bg-card focus-within:border-ring focus-within:ring-ring/30 rounded-xl border shadow-sm transition-shadow focus-within:ring-3">
        {/* 占位内容区：点击非编辑区也能聚焦编辑器（原 textarea 的整域点击语义） */}
        <div onClick={() => editor?.commands.focus()}>
          <EditorContent editor={editor} />
        </div>
        <div className="flex items-center gap-1 px-2.5 pb-2.5">
          {toolbar}
          <div className="ml-auto flex items-center gap-1">
            {trailing}
            {showStop ? (
              // Deliberately not gated on `disabled`: the editor is locked
              // while a turn streams, but stopping that turn is exactly what
              // the user needs to be able to do then.
              <Button
                type="button"
                size="icon"
                variant="destructive"
                className="h-8 w-8 shrink-0 rounded-full"
                onClick={onStop}
                aria-label="中断生成"
              >
                <Square className="h-3.5 w-3.5 fill-current" />
              </Button>
            ) : (
              <Button
                type="submit"
                size="icon"
                className="h-8 w-8 shrink-0 rounded-full"
                disabled={isEmpty || disabled}
                aria-label="发送"
              >
                <ArrowUp className="h-4 w-4" />
              </Button>
            )}
          </div>
        </div>
      </div>
    </form>
  );
}
