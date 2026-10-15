// InputBar 的三种图片入口（粘贴 / 拖拽 / 文件选择）与发送时的附件 id 透传。
// 断言对象是真实 DOM 结构：chip 的缩略图、移除按钮、发送 payload。
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { useState } from 'react';
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

function setup(props: { imageInput?: ('text' | 'image')[]; onSend?: (p: { text: string; attachments: string[] }) => void } = {}) {
  const onSend = props.onSend ?? vi.fn();
  let editor: Editor | undefined;
  const utils = render(
    <InputBar
      sessionId="s1"
      onSend={onSend}
      imageInput={props.imageInput}
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

  // Intent rewritten (Task 3b, spec D5): text/PDF attachments are available
  // to EVERY model, so a text-only model no longer closes the whole entry —
  // only image files are filtered out. The reason line stays visible.
  it('keeps the attachment entry open but filters images when the model declares text-only input', async () => {
    stubUpload();
    setup({ imageInput: ['text'] });
    // The reason line stays visible, not silently dropped.
    expect(screen.getByText('当前模型不支持图片输入')).toBeInTheDocument();
    // The entry stays open (spec D5: text/PDF are available to every model).
    expect(screen.getByTestId('attachment-file-input')).toBeInTheDocument();
    // Images are still refused at every entry: drop…
    const dropZone = screen.getByTestId('composer-drop-zone');
    fireEvent.drop(dropZone, {
      dataTransfer: { files: [pngFile()], items: [], types: ['Files'] },
    });
    // …paste…
    fireEvent.paste(screen.getByTestId('input-editor'), {
      clipboardData: { files: [pngFile()], items: [], types: ['Files'], getData: () => '' },
    });
    // …and the picker.
    const input = screen.getByTestId('attachment-file-input') as HTMLInputElement;
    Object.defineProperty(input, 'files', { value: [pngFile()], configurable: true });
    fireEvent.change(input);
    // Give the async add a chance to misfire before asserting absence.
    await new Promise((r) => setTimeout(r, 20));
    expect(screen.queryByTestId('attachment-chip')).not.toBeInTheDocument();

    // A whitelisted text file still passes through the picker (spec D5).
    Object.defineProperty(input, 'files', {
      value: [new File(['hello'], 'notes.txt', { type: 'text/plain' })],
      configurable: true,
    });
    fireEvent.change(input);
    await waitFor(() => expect(screen.getByTestId('attachment-chip')).toBeInTheDocument());
    expect(screen.getByTestId('attachment-chip')).toHaveTextContent('notes.txt');
  });
});

// 欢迎屏（新会话）：sessionId 尚不存在。三个图片入口必须保持可用——首次
// attach 时经 ensureSessionId 创建草稿会话，上传挂在其名下，发送走 onSend。
describe('InputBar attachments — welcome screen (no session yet)', () => {
  function WelcomeHarness(props: {
    onSend: (p: { text: string; attachments: string[] }) => void;
    onEditorReady?: (e: Editor) => void;
  }) {
    const [sid, setSid] = useState<string | null>(null);
    return (
      <InputBar
        sessionId={sid}
        ensureSessionId={() => {
          if (sid) return sid;
          setSid('draft-1');
          return 'draft-1';
        }}
        onSend={props.onSend}
        onEditorReady={props.onEditorReady}
      />
    );
  }

  it('keeps the paperclip entry available before a session exists', () => {
    stubUpload();
    render(<WelcomeHarness onSend={vi.fn()} />);
    expect(screen.getByRole('button', { name: '添加图片' })).toBeInTheDocument();
  });

  it('uploads a dropped image against the draft session and sends its id', async () => {
    stubUpload();
    const onSend = vi.fn();
    let editor: Editor | undefined;
    render(
      <WelcomeHarness
        onSend={onSend}
        onEditorReady={(e) => {
          editor = e;
        }}
      />,
    );
    fireEvent.drop(screen.getByTestId('composer-drop-zone'), {
      dataTransfer: { files: [pngFile()], items: [], types: ['Files'] },
    });
    await waitFor(() =>
      expect(screen.getByTestId('attachment-chip').dataset.status).toBe('ready'),
    );
    editor!.commands.insertContent('look');
    // isEmpty 的更新随事务异步提交：等发送键真正可用再点击。
    await waitFor(() => expect(screen.getByTestId('composer-send')).not.toBeDisabled());
    fireEvent.click(screen.getByTestId('composer-send'));
    await waitFor(() =>
      expect(onSend).toHaveBeenCalledWith({ text: 'look', attachments: ['att-1'] }),
    );
  });

  it('accepts a pasted image before a session exists', async () => {
    stubUpload();
    const onSend = vi.fn();
    render(<WelcomeHarness onSend={onSend} />);
    fireEvent.paste(screen.getByTestId('input-editor'), {
      clipboardData: { files: [pngFile()], items: [], types: ['Files'], getData: () => '' },
    });
    await waitFor(() =>
      expect(screen.getByTestId('attachment-chip').dataset.status).toBe('ready'),
    );
  });
});

// Non-image attachments (spec D6): the picker admits the gateway whitelist
// (text/*, application/pdf, application/json), non-image chips show the
// filename without a thumbnail, and the upload payload carries the file
// name (spec D4 wire field). Zip and other binaries stay rejected.
describe('InputBar attachments — non-image whitelist (spec D6)', () => {
  function textFile(name = 'notes.txt', type = 'text/plain') {
    return new File(['hello inline'], name, { type });
  }
  function pdfFile(name = 'report.pdf') {
    return new File([Uint8Array.from([0x25, 0x50, 0x44, 0x46])], name, {
      type: 'application/pdf',
    });
  }
  function zipFile(name = 'archive.zip') {
    return new File([Uint8Array.from([0x50, 0x4b, 0x03, 0x04])], name, {
      type: 'application/zip',
    });
  }

  it('widens the file input accept attribute to the gateway whitelist', () => {
    stubUpload();
    setup();
    expect(screen.getByTestId('attachment-file-input')).toHaveAttribute(
      'accept',
      'image/*,text/*,application/pdf,application/json',
    );
  });

  it('uploads a pasted text file with its name and shows a filename chip without a thumbnail', async () => {
    const fetchSpy = vi.fn(
      async (_input: string | URL | Request, _init?: RequestInit) =>
        new Response(
          JSON.stringify({ id: 'att-txt', mimeType: 'text/plain', size: 12 }),
          { status: 201 },
        ),
    );
    vi.stubGlobal('fetch', fetchSpy);
    const { editorEl } = setup();
    fireEvent.paste(editorEl(), {
      clipboardData: { files: [textFile()], items: [], types: ['Files'], getData: () => '' },
    });
    await waitFor(() => expect(screen.getByTestId('attachment-chip')).toBeInTheDocument());
    const chip = screen.getByTestId('attachment-chip');
    // Filename visible, no <img> thumbnail for a non-image item (spec D6).
    expect(chip).toHaveTextContent('notes.txt');
    expect(chip.querySelector('img')).toBeNull();
    await waitFor(() => expect(chip).toHaveAttribute('data-status', 'ready'));

    // The upload payload carries the wire `name` field (spec D4/D6).
    const body = JSON.parse((fetchSpy.mock.calls[0]?.[1]?.body ?? '') as string) as {
      sessionId: string;
      mimeType: string;
      name: string;
    };
    expect(body).toMatchObject({
      sessionId: 's1',
      mimeType: 'text/plain',
      name: 'notes.txt',
    });
  });

  it('accepts a dropped PDF without a thumbnail', async () => {
    stubUpload();
    setup();
    fireEvent.drop(screen.getByTestId('composer-drop-zone'), {
      dataTransfer: { files: [pdfFile()], items: [], types: ['Files'] },
    });
    await waitFor(() => expect(screen.getByTestId('attachment-chip')).toBeInTheDocument());
    const chip = screen.getByTestId('attachment-chip');
    expect(chip).toHaveTextContent('report.pdf');
    expect(chip.querySelector('img')).toBeNull();
  });

  it('accepts a JSON file chosen through the button', async () => {
    stubUpload();
    setup();
    const input = screen.getByTestId('attachment-file-input') as HTMLInputElement;
    Object.defineProperty(input, 'files', {
      value: [textFile('config.json', 'application/json')],
      configurable: true,
    });
    fireEvent.change(input);
    await waitFor(() => expect(screen.getByTestId('attachment-chip')).toBeInTheDocument());
    expect(screen.getByTestId('attachment-chip')).toHaveTextContent('config.json');
  });

  it('rejects a zip file at every entry point (no chip, no request)', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    setup();
    fireEvent.paste(screen.getByTestId('input-editor'), {
      clipboardData: { files: [zipFile()], items: [], types: ['Files'], getData: () => '' },
    });
    fireEvent.drop(screen.getByTestId('composer-drop-zone'), {
      dataTransfer: { files: [zipFile()], items: [], types: ['Files'] },
    });
    const input = screen.getByTestId('attachment-file-input') as HTMLInputElement;
    Object.defineProperty(input, 'files', { value: [zipFile()], configurable: true });
    fireEvent.change(input);
    // Give the async add path a chance to misfire before asserting absence.
    await new Promise((r) => setTimeout(r, 20));
    expect(screen.queryByTestId('attachment-chip')).not.toBeInTheDocument();
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
