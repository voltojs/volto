// 历史消息中的图片块渲染为真实 <img>，指向附件路由；附件被清理时降级为
// 说明文案而不是破碎图标。InputBar 的 vision 三态门控：false 关入口并说明
// 原因，undefined（能力未知）保持可用。
//
// 浏览器鉴权：网关用 HttpOnly cookie（同源 /gateway rewrite），同源 <img>
// 请求自动携带，无需 crossOrigin / credentials 属性。
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { MessageBubble } from '../MessageBubble';
import { InputBar } from '../InputBar';

// jsdom 未实现 Range.getClientRects（tiptap focus 的 rAF 回调会踩空），
// 与 input-bar.test.tsx 同型补丁。
if (typeof Range !== 'undefined' && !Range.prototype.getClientRects) {
  const emptyRectList: DOMRectList = Object.assign([] as DOMRect[], {
    item: () => null,
  });
  Range.prototype.getClientRects = () => emptyRectList;
  Range.prototype.getBoundingClientRect = () => new DOMRect(0, 0, 0, 0);
}

describe('historical image rendering', () => {
  it('renders an image block as an img pointing at the attachment route', () => {
    render(
      <MessageBubble
        message={{
          id: 'm1',
          role: 'user',
          blocks: [
            { type: 'text', text: 'what is this' },
            {
              type: 'image',
              attachmentId: 'att-9',
              mediaType: 'image/png',
              width: 8,
              height: 8,
            },
          ],
          content: 'what is this',
          timestamp: 0,
        }}
        sessionId="s1"
      />,
    );
    const img = screen.getByRole('img');
    expect(img.getAttribute('src')).toContain('/attachments/att-9');
    expect(img.getAttribute('src')).toContain('sessionId=s1');
    // 文字仍在，图片是追加而不是替换。
    expect(screen.getByText('what is this')).toBeInTheDocument();
  });

  it('renders assistant-path images the same way', () => {
    render(
      <MessageBubble
        message={{
          id: 'm1',
          role: 'assistant',
          blocks: [
            {
              type: 'image',
              attachmentId: 'att-9',
              mediaType: 'image/png',
            },
          ],
          content: '',
          timestamp: 0,
        }}
        sessionId="s1"
      />,
    );
    const img = screen.getByRole('img');
    expect(img.getAttribute('src')).toContain('/attachments/att-9');
    expect(img.getAttribute('src')).toContain('sessionId=s1');
  });

  it('still renders a plain string message', () => {
    render(
      <MessageBubble
        message={{
          id: 'm1',
          role: 'user',
          blocks: [{ type: 'text', text: 'hello' }],
          content: 'hello',
          timestamp: 0,
        }}
        sessionId="s1"
      />,
    );
    expect(screen.getByText('hello')).toBeInTheDocument();
  });

  it('shows a placeholder when the attachment is gone instead of a broken image', () => {
    render(
      <MessageBubble
        message={{
          id: 'm1',
          role: 'user',
          blocks: [
            { type: 'image', attachmentId: 'missing', mediaType: 'image/png' },
          ],
          content: '',
          timestamp: 0,
        }}
        sessionId="s1"
      />,
    );
    const img = screen.getByRole('img');
    // React 的 onError 走合成事件；原生 dispatchEvent 在根委托下不触发。
    fireEvent.error(img);
    expect(
      screen.getByText(/图片已不可用|unavailable/i),
    ).toBeInTheDocument();
  });

  it('skips the image src when there is no session rather than requesting a doomed URL', () => {
    render(
      <MessageBubble
        message={{
          id: 'm1',
          role: 'user',
          blocks: [
            { type: 'image', attachmentId: 'att-9', mediaType: 'image/png' },
          ],
          content: '',
          timestamp: 0,
        }}
      />,
    );
    // 无 sessionId 时不发请求：占位文案保留 attachmentId 便于排查。
    expect(screen.queryByRole('img')).not.toBeInTheDocument();
    expect(screen.getByText(/att-9/)).toBeInTheDocument();
  });
});

describe('vision gating in the composer', () => {
  it('disables the attachment entries when the model has no vision support', () => {
    render(
      <InputBar sessionId="s1" onSend={vi.fn()} imageInput={['text']} />,
    );
    // Task 8 的实现选择是「入口整体不渲染」——比 disabled 更强的门控。
    expect(
      screen.queryByTestId('attachment-file-input'),
    ).not.toBeInTheDocument();
    // 关掉能力却不说原因，用户只会以为功能坏了。
    expect(
      screen.getByText(/不支持图片|does not support image/i),
    ).toBeInTheDocument();
  });

  it('keeps the entries enabled when vision support is unknown', () => {
    // 三态：absent 是「未知」不是「不支持」——网关描述不了模型能力时，
    // 不得静默封锁一条本可用的路径。
    render(
      <InputBar
        sessionId="s1"
        onSend={vi.fn()}
        imageInput={undefined}
      />,
    );
    expect(screen.getByTestId('attachment-file-input')).not.toBeDisabled();
  });
});
