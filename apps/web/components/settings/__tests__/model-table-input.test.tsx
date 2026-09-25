import { describe, expect, it } from 'vitest';
import { useState } from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import { ModelTable, type DraftModel } from '../ModelTable';

function row(overrides: Partial<DraftModel> = {}): DraftModel {
  return {
    clientKey: 'k1',
    id: '',
    name: '',
    code: 'deepseek-flash',
    reasoning: false,
    ...overrides,
  };
}

const flashLimits = {
  images: {
    resize: {
      maxWidth: 2000,
      maxHeight: 2000,
      maxBytes: 4718592,
      jpegQuality: 80,
    },
  },
};

describe('ModelTable input expand row', () => {
  it('starts collapsed and reveals the input groups on chevron click', () => {
    // A1 (controller-approved): seed this row with limits so expanding reveals
    // BOTH groups; "inputLimits 缺失 → 整个分组不渲染" still binds (#4 below).
    render(
      <ModelTable
        models={[row({ inputLimits: flashLimits })]}
        onChange={() => {}}
      />,
    );
    expect(screen.queryByText('输入类型')).toBeNull();
    fireEvent.click(screen.getByLabelText('展开模型 1'));
    expect(screen.getByText('输入类型')).toBeTruthy();
    expect(screen.getByLabelText('输入限制')).toBeTruthy();
  });

  it('renders text disabled+checked and image checked for an undeclared model (UNKNOWN shows permissive)', () => {
    render(<ModelTable models={[row()]} onChange={() => {}} />);
    fireEvent.click(screen.getByLabelText('展开模型 1'));
    // B (controller-approved): Base UI renders role=checkbox on a span —
    // aria-checked/aria-disabled are the readable surface, not .checked/.disabled.
    const text = screen.getByLabelText('输入-文本 1');
    const image = screen.getByLabelText('输入-图片 1');
    expect(text).toBeChecked();
    expect(text).toHaveAttribute('aria-disabled', 'true');
    expect(image).toBeChecked();
  });

  it('writes ["text"] when image is unchecked and back to ["text","image"] when re-checked', () => {
    const changes: DraftModel[][] = [];
    // C (controller-approved): ModelTable is controlled — the harness must feed
    // drafts back into `models`, mirroring how both real form cards consume it;
    // otherwise the second toggle re-fires with the stale checked value.
    function Harness() {
      const [models, setModels] = useState([row({ input: ['text', 'image'] })]);
      return (
        <ModelTable
          models={models}
          onChange={(next) => {
            changes.push(next);
            setModels(next);
          }}
        />
      );
    }
    render(<Harness />);
    fireEvent.click(screen.getByLabelText('展开模型 1'));
    fireEvent.click(screen.getByLabelText('输入-图片 1'));
    expect(changes.at(-1)?.[0]?.input).toEqual(['text']);
    fireEvent.click(screen.getByLabelText('输入-图片 1'));
    expect(changes.at(-1)?.[0]?.input).toEqual(['text', 'image']);
  });

  it('hides the input-limits group when the model has none', () => {
    render(
      <ModelTable
        models={[row({ input: ['text', 'image'] })]}
        onChange={() => {}}
      />,
    );
    fireEvent.click(screen.getByLabelText('展开模型 1'));
    expect(screen.queryByLabelText('输入限制')).toBeNull();
  });

  it('formats the input-limits group when the directory declares limits', () => {
    render(
      <ModelTable
        models={[row({ input: ['text', 'image'], inputLimits: flashLimits })]}
        onChange={() => {}}
      />,
    );
    fireEvent.click(screen.getByLabelText('展开模型 1'));
    const limits = screen.getByLabelText('输入限制');
    expect(limits.textContent).toContain('≤2000×2000');
    expect(limits.textContent).toContain('≤4.5MB');
    expect(limits.textContent).toContain('JPEG 80');
  });

  it('seeds input and limits from codeOptions when the typed code matches', () => {
    const changes: DraftModel[][] = [];
    render(
      <ModelTable
        models={[row({ code: '' })]}
        onChange={(next) => changes.push(next)}
        codeListId="codes"
        codeOptions={[
          {
            code: 'deepseek-flash',
            name: 'DeepSeek V4.1 Flash',
            input: ['text', 'image'],
            inputLimits: flashLimits,
          },
        ]}
      />,
    );
    fireEvent.change(screen.getByLabelText('模型 ID 1'), {
      target: { value: 'deepseek-flash' },
    });
    const seeded = changes.at(-1)?.[0];
    expect(seeded?.input).toEqual(['text', 'image']);
    expect(seeded?.inputLimits).toEqual(flashLimits);
  });
});
