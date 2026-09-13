import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
import type { Editor } from '@tiptap/react';
import { InputBar, type InputBarProps } from '../InputBar';

function setup(props: Partial<InputBarProps> = {}) {
  const onSubmit = vi.fn();
  const onInputAction = vi.fn();
  let editor: Editor | undefined;
  const utils = render(
    <InputBar
      onSubmit={onSubmit}
      onInputAction={onInputAction}
      onEditorReady={(e) => {
        editor = e;
      }}
      {...props}
    />,
  );
  const editorEl = () => utils.container.querySelector('[data-testid="input-editor"]')!;
  const sendButton = () => screen.getByRole('button', { name: '发送' });
  return { onSubmit, onInputAction, get editor() { return editor!; }, editorEl, sendButton, ...utils };
}

describe('InputBar（tiptap 底座）', () => {
  it('渲染 contenteditable 编辑器，空内容时发送按钮禁用', () => {
    const { editorEl, sendButton } = setup();
    expect(editorEl().getAttribute('contenteditable')).toBe('true');
    expect((sendButton() as HTMLButtonElement).disabled).toBe(true);
  });

  it('输入文本 → 点击发送 → onSubmit(文本) + 编辑器清空', () => {
    const { editor, onSubmit, sendButton } = setup();
    act(() => void editor.commands.insertContent('你好'));
    expect((sendButton() as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(sendButton());
    expect(onSubmit).toHaveBeenCalledWith('你好');
    expect(editor.isEmpty).toBe(true);
  });

  it('Enter 提交、Shift+Enter 换行（单段落 + HardBreak）', () => {
    const { editor, onSubmit, editorEl } = setup();
    act(() => void editor.commands.insertContent('a'));
    fireEvent.keyDown(editorEl(), { key: 'Enter', shiftKey: true, bubbles: true, cancelable: true });
    act(() => void editor.commands.insertContent('b'));
    fireEvent.keyDown(editorEl(), { key: 'Enter', bubbles: true, cancelable: true });
    expect(onSubmit).toHaveBeenCalledWith('a\nb');
    expect(editor.getJSON().content?.length).toBe(1); // 永远单段落
  });

  it('IME 组合中的 Enter 不发送', () => {
    const { editor, onSubmit, editorEl } = setup();
    act(() => void editor.commands.insertContent('你好'));
    const event = new KeyboardEvent('keydown', { key: 'Enter', isComposing: true, bubbles: true, cancelable: true });
    editorEl().dispatchEvent(event);
    expect(onSubmit).not.toHaveBeenCalled();
    expect(editor.isEmpty).toBe(false);
  });

  it('/clear 拦截：onInputAction 被调、onSubmit 不被调、编辑器清空', () => {
    const { editor, onSubmit, onInputAction, sendButton } = setup();
    act(() => void editor.commands.insertContent('/clear'));
    fireEvent.click(sendButton());
    expect(onInputAction).toHaveBeenCalledWith('clear-session');
    expect(onSubmit).not.toHaveBeenCalled();
    expect(editor.isEmpty).toBe(true);
  });

  it('/clear now 不拦截（交服务端 Unknown command 兜底）', () => {
    const { editor, onSubmit, onInputAction, sendButton } = setup();
    act(() => void editor.commands.insertContent('/clear now'));
    fireEvent.click(sendButton());
    expect(onInputAction).not.toHaveBeenCalled();
    expect(onSubmit).toHaveBeenCalledWith('/clear now');
  });

  it('mention 节点序列化为 @路径 纯文本', () => {
    const { editor, onSubmit, sendButton } = setup();
    act(() =>
      void editor.commands.insertContent({
        type: 'mention',
        attrs: { id: 'src/a.ts', label: 'src/a.ts' },
      }),
    );
    fireEvent.click(sendButton());
    expect(onSubmit).toHaveBeenCalledWith('@src/a.ts');
  });

  it('mention + 文本混合序列化保留 @ 前缀', () => {
    const { editor, onSubmit, sendButton } = setup();
    act(() => {
      editor.commands.insertContent('看下 ');
      editor.commands.insertContent({ type: 'mention', attrs: { id: 'lib/x.ts', label: 'lib/x.ts' } });
      editor.commands.insertContent(' 这个文件');
    });
    fireEvent.click(sendButton());
    expect(onSubmit).toHaveBeenCalledWith('看下 @lib/x.ts 这个文件');
  });

  it('disabled 时编辑器不可编辑、发送禁用', () => {
    const { editorEl, sendButton } = setup({ disabled: true });
    expect(editorEl().getAttribute('contenteditable')).toBe('false');
    expect((sendButton() as HTMLButtonElement).disabled).toBe(true);
  });

  it('富文本粘贴退化为纯文本（schema 无 mark 扩展，粗体等被丢弃）', () => {
    const { onSubmit, sendButton, editorEl } = setup();
    // 真实粘贴路径：clipboard 的 text/html 经 prosemirror-view 默认 handler
    // 走 schema 解析，无 mark 扩展时粗体被丢弃、文本保留。（不能用
    // insertContent(HTML 串) 作代理——无 mark schema 下解析结果是纯文本，
    // 会命中 tiptap insertContentAt 的 isOnlyTextContent 快速路径，把原始
    // 字符串当纯文本插入，schema 收敛被绕过。）
    fireEvent.paste(editorEl(), {
      clipboardData: { getData: () => '<strong>加粗</strong> 正文' },
    });
    fireEvent.click(sendButton());
    expect(onSubmit).toHaveBeenCalledWith('加粗 正文');
  });
});
