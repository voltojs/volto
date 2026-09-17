// InputBar 的三种图片入口（粘贴 / 拖拽 / 文件选择）与发送时的附件 id 透传。
// 断言对象是真实 DOM 结构：chip 的缩略图、移除按钮、发送 payload。
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import type { Editor } from '@tiptap/react';
import { InputBar } from '../InputBar';

// jsdom 未实现 Range.getClientRects（tiptap focus 的 rAF 回调会踩空），
// 与 input-bar.test.tsx 同型补丁。
if (typeof Range !== 'undefined' && !Range.prototype.getClientRects) {
  const emptyRectList: DOMRectList = Object.assign([] as DOMRect[], { item: () => null });
  Range.prototype.getClientRects = () => emptyRectList;
  Range.prototype.getBoundingClientRect = () => new DOMRect(0, 0, 0, 0);
}

function pngFile(name = 'shot.png') {
  return new File([Uint8Array.from([0x89, 0x50, 0x4e, 0x47])], name, { type: 'image/png' });
}

function stubUpload() {
  vi.stubGlobal(
    'fetch',
    vi.fn(
      async () =>
        new Response(JSON.stringify({ id: 'att-1', mimeType: 'image/png', size: 4 }), {
          status: 201,
        }),
    ),
  );
}

let objectUrlSeq = 0;
beforeEach(() => {
  objectUrlSeq = 0;
  // jsdom 不实现 object URL；挂在既有 URL 构造器上（不要整体替换）。
  Object.assign(URL, {
    createObjectURL: vi.fn(() => `blob:mock-${++objectUrlSeq}`),
    revokeObjectURL: vi.fn(),
  });
});
afterEach(() => {
  vi.unstubAllGlobals();
});

function setup(props: { visionSupported?: boolean; onSend?: (p: { text: string; attachments: string[] }) => void } = {}) {
  const onSend = props.onSend ?? vi.fn();
  let editor: Editor | undefined;
  const utils = render(
    <InputBar
      sessionId="s1"
      onSend={onSend}
      visionSupported={props.visionSupported}
      onEditorReady={(e) => {
        editor = e;
      }}
    />,
  );
  const editorEl = () => utils.container.querySelector('[data-testid="input-editor"]') as HTMLElement;
  return { onSend, get editor() { return editor!; }, editorEl, ...utils };
}

describe('InputBar attachments', () => {
  it('accepts a pasted image', async () => {
    stubUpload();
    const { editorEl } = setup();
    fireEvent.paste(editorEl(), {
      clipboardData: { files: [pngFile()], items: [], types: ['Files'], getData: () => '' },
    });
    await waitFor(() => expect(screen.getByTestId('attachment-chip')).toBeInTheDocument());
    // 缩略图来自 hook 的 objectURL，不是占位。
    expect(screen.getByTestId('attachment-chip').querySelector('img')).toHaveAttribute(
      'src',
      'blob:mock-1',
    );
  });

  it('accepts a dropped image', async () => {
    stubUpload();
    setup();
    const dropZone = screen.getByTestId('composer-drop-zone');
    fireEvent.drop(dropZone, {
      dataTransfer: { files: [pngFile()], items: [], types: ['Files'] },
    });
    await waitFor(() => expect(screen.getByTestId('attachment-chip')).toBeInTheDocument());
  });

  it('accepts a file chosen through the button', async () => {
    stubUpload();
    setup();
    const input = screen.getByTestId('attachment-file-input') as HTMLInputElement;
    Object.defineProperty(input, 'files', { value: [pngFile()], configurable: true });
    fireEvent.change(input);
    await waitFor(() => expect(screen.getByTestId('attachment-chip')).toBeInTheDocument());
  });

  it('removes one chip without clearing the typed text', async () => {
    stubUpload();
    const { editor } = setup();
    editor.commands.insertContent('look at this');
    const editorElRef = screen.getByTestId('input-editor');
    fireEvent.paste(editorElRef, {
      clipboardData: { files: [pngFile()], items: [], types: ['Files'], getData: () => '' },
    });
    await waitFor(() => expect(screen.getByTestId('attachment-chip')).toBeInTheDocument());

    fireEvent.click(screen.getByTestId('attachment-chip-remove'));
    await waitFor(() => expect(screen.queryByTestId('attachment-chip')).not.toBeInTheDocument());
    // 移除 chip 不得清空已输入文字。
    expect(screen.getByTestId('input-editor').textContent).toContain('look at this');
  });

  it('sends the ready attachment ids together with the message', async () => {
    stubUpload();
    const { onSend, editor } = setup();
    editor.commands.insertContent('what is this');
    fireEvent.paste(screen.getByTestId('input-editor'), {
      clipboardData: { files: [pngFile()], items: [], types: ['Files'], getData: () => '' },
    });
    await waitFor(() => expect(screen.getByTestId('attachment-chip')).toBeInTheDocument());
    // 上传是异步的：等 chip 进入 ready 才有服务端 id 可发。
    await waitFor(() =>
      expect(screen.getByTestId('attachment-chip')).toHaveAttribute('data-status', 'ready'),
    );

    fireEvent.click(screen.getByTestId('composer-send'));
    expect(onSend).toHaveBeenCalledWith(
      expect.objectContaining({ text: 'what is this', attachments: ['att-1'] }),
    );
  });

  it('does not send while an upload is still in flight', async () => {
    // fetch 永不 resolve → chip 停在 uploading，id 尚不存在。
    vi.stubGlobal('fetch', vi.fn(() => new Promise(() => {})));
    const { onSend, editor } = setup();
    editor.commands.insertContent('hi');
    fireEvent.paste(screen.getByTestId('input-editor'), {
      clipboardData: { files: [pngFile()], items: [], types: ['Files'], getData: () => '' },
    });
    await waitFor(() => expect(screen.getByTestId('attachment-chip')).toBeInTheDocument());
    expect(screen.getByTestId('attachment-chip')).toHaveAttribute('data-status', 'uploading');

    fireEvent.click(screen.getByTestId('composer-send'));
    // 此刻发送会引用一个还不存在的 id。
    expect(onSend).not.toHaveBeenCalled();
  });

  it('disables every entry when the model has no vision support', async () => {
    stubUpload();
    setup({ visionSupported: false });
    // 原因必须可见，而不是静默消失。
    expect(screen.getByText('当前模型不支持图片输入')).toBeInTheDocument();
    // 文件选择入口整体不渲染（不存在可点的 paperclip / input）。
    expect(screen.queryByTestId('attachment-file-input')).not.toBeInTheDocument();
    // 拖拽落点仍在（卡片本身），但 drop 不得产生 chip。
    const dropZone = screen.getByTestId('composer-drop-zone');
    fireEvent.drop(dropZone, {
      dataTransfer: { files: [pngFile()], items: [], types: ['Files'] },
    });
    // 粘贴同样不接管。
    fireEvent.paste(screen.getByTestId('input-editor'), {
      clipboardData: { files: [pngFile()], items: [], types: ['Files'], getData: () => '' },
    });
    // 给异步 add 一个不可能发生的机会：稍等后仍无 chip。
    await new Promise((r) => setTimeout(r, 20));
    expect(screen.queryByTestId('attachment-chip')).not.toBeInTheDocument();
  });
});
