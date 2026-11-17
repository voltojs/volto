import { describe, expect, it } from 'vitest';
import { useState } from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import {
  emptyDraftModel,
  ModelTable,
  toCatalogDrafts,
  toDraftModels,
  type DraftModel,
} from '../ModelTable';
import type { CatalogProviderModel, Model } from '@/lib/config-api';

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

/** A resolved `reasoning.levels` array as `GET /providers` sends it (7 entries, display order). */
const levelsSeed = [
  { id: 'off', supported: true, overridden: false },
  { id: 'minimal', supported: false, overridden: false },
  { id: 'low', supported: true, value: 'low', overridden: false },
  { id: 'medium', supported: true, value: 'medium', overridden: false },
  { id: 'high', supported: true, value: 'high', overridden: false },
  { id: 'xhigh', supported: false, overridden: false },
  { id: 'max', supported: false, overridden: false },
];

const mapSeed = { medium: null, high: 'maximum' };

describe('thinking level draft seeding', () => {
  it('toCatalogDrafts seeds thinkingLevelMap and thinkingLevels from the wire model', () => {
    const wire: CatalogProviderModel = {
      code: 'claude-x',
      reasoning: { efforts: [{ id: 'high', name: 'High' }], levels: levelsSeed },
      thinkingLevelMap: mapSeed,
    };
    const draft = toCatalogDrafts([wire])[0]!;
    // The stored map is the editable draft; the resolved levels are the
    // read-only display seed — both ride in on GET /providers.
    expect(draft.thinkingLevelMap).toEqual(mapSeed);
    expect(draft.thinkingLevels).toEqual(levelsSeed);
  });

  it('toCatalogDrafts leaves both fields undefined when the wire carries neither', () => {
    const draft = toCatalogDrafts([{ code: 'plain' }])[0]!;
    expect(draft.thinkingLevelMap).toBeUndefined();
    expect(draft.thinkingLevels).toBeUndefined();
  });

  it('toDraftModels seeds thinkingLevelMap and thinkingLevels for a custom wire model', () => {
    const wire: Model = {
      id: 'm1',
      name: 'MiMo',
      code: 'mimo-v2.5',
      reasoning: { efforts: [{ id: 'high', name: 'High' }], levels: levelsSeed },
      thinkingLevelMap: mapSeed,
    };
    const draft = toDraftModels([wire])[0]!;
    expect(draft.thinkingLevelMap).toEqual(mapSeed);
    expect(draft.thinkingLevels).toEqual(levelsSeed);
  });

  it('emptyDraftModel starts with no thinking level fields', () => {
    const draft = emptyDraftModel();
    expect(draft.thinkingLevelMap).toBeUndefined();
    expect(draft.thinkingLevels).toBeUndefined();
  });
});

// jsdom lacks the pointer-capture / scroll APIs Base UI's Select uses — same
// shims as thinking-levels-editor.test.tsx, needed once a spec opens a dropdown.
Element.prototype.hasPointerCapture ??= () => false;
Element.prototype.setPointerCapture ??= () => {};
Element.prototype.releasePointerCapture ??= () => {};
Element.prototype.scrollIntoView ??= () => {};

/** A row whose reasoning model reports low/medium/high as offered tiers. */
const editorRow = () => row({ reasoning: true, thinkingLevels: levelsSeed });

const disabledSentence = '该模型未启用推理，以下档位不会生效';

describe('thinking levels editor mounted in the expand area', () => {
  it('renders the editor for an expanded row and hides it while collapsed', () => {
    render(<ModelTable models={[editorRow()]} onChange={() => {}} />);
    expect(screen.queryByText('推理等级')).toBeNull();
    fireEvent.click(screen.getByLabelText('展开模型 1'));
    expect(screen.getByText('推理等级')).toBeTruthy();
    // The seeded rows carry the real wire values — no placeholders.
    expect(screen.getByLabelText('API 参数值 1')).toHaveValue('low');
    expect(screen.getByLabelText('API 参数值 2')).toHaveValue('medium');
    expect(screen.getByLabelText('API 参数值 3')).toHaveValue('high');
  });

  it('emits no override when the table is neither edited nor pruned', () => {
    const changes: DraftModel[][] = [];
    render(
      <ModelTable models={[editorRow()]} onChange={(next) => changes.push(next)} />,
    );
    fireEvent.click(screen.getByLabelText('展开模型 1'));
    // Seeding is not an edit: the draft keeps thinkingLevelMap undefined, so
    // pi-ai's defaults stay in force.
    expect(changes).toHaveLength(0);
    expect(changes.at(-1)?.[0]?.thinkingLevelMap).toBeUndefined();
  });

  it('deletes a listed tier as null in the draft map without touching reasoning', () => {
    const changes: DraftModel[][] = [];
    function Harness() {
      const [models, setModels] = useState([editorRow()]);
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
    // Rows: low / medium / high — delete medium.
    fireEvent.click(screen.getByRole('button', { name: '删除推理等级行 2' }));
    const patched = changes.at(-1)?.[0];
    expect(patched?.thinkingLevelMap).toMatchObject({
      low: 'low',
      high: 'high',
      medium: null,
    });
    expect(patched?.reasoning).toBe(true);
  });

  it('editing the table does NOT flip the reasoning flag', () => {
    const changes: DraftModel[][] = [];
    render(
      <ModelTable
        models={[row({ reasoning: false, thinkingLevels: levelsSeed })]}
        onChange={(next) => changes.push(next)}
      />,
    );
    fireEvent.click(screen.getByLabelText('展开模型 1'));
    fireEvent.change(screen.getByLabelText('API 参数值 1'), {
      target: { value: 'lowX' },
    });
    const patched = changes.at(-1)?.[0];
    expect(patched?.reasoning).toBe(false);
    expect(patched?.thinkingLevelMap).toMatchObject({ low: 'lowX' });
  });

  it('renders the disabled-reasoning sentence exactly when reasoning is false', () => {
    // Two tables in one render: index 0 = reasoning off, index 1 = on.
    render(
      <div>
        <ModelTable
          models={[row({ reasoning: false, thinkingLevels: levelsSeed })]}
          onChange={() => {}}
        />
        <ModelTable
          models={[row({ clientKey: 'k2', reasoning: true, thinkingLevels: levelsSeed })]}
          onChange={() => {}}
        />
      </div>,
    );
    const expandButtons = screen.getAllByLabelText('展开模型 1');
    fireEvent.click(expandButtons[0]!);
    fireEvent.click(expandButtons[1]!);
    // One plain sentence, no greyed wrapper, no aria-disabled: the editor
    // stays fully interactive either way.
    const sentences = screen.getAllByText(disabledSentence);
    expect(sentences).toHaveLength(1);
    for (const button of screen.getAllByRole('button', { name: /删除推理等级行/ })) {
      expect(button).not.toHaveAttribute('aria-disabled');
    }
    expect(screen.queryByRole('switch')).toBeNull();
  });

  it("clears the previous code's thinking level seeds when the code changes", () => {
    // The resolved levels and the stored map describe the OLD code. Keeping
    // them makes the editor show values that will not be sent for the new one;
    // clearing both remounts the editor with no seeds.
    const changes: DraftModel[][] = [];
    const { rerender } = render(
      <ModelTable
        models={[
          row({
            reasoning: true,
            thinkingLevelMap: { low: 'custom' },
            thinkingLevels: [
              { id: 'low', supported: true, value: 'custom', overridden: true },
            ],
          }),
        ]}
        onChange={(next) => changes.push(next)}
      />,
    );
    fireEvent.change(screen.getByLabelText('模型 ID 1'), {
      target: { value: 'another-model' },
    });
    const patched = changes.at(-1)?.[0];
    expect(patched?.code).toBe('another-model');
    expect(patched?.thinkingLevelMap).toBeUndefined();
    expect(patched?.thinkingLevels).toBeUndefined();
    // Feeding the patched draft back remounts the keyed editor with no seeds,
    // so the old model's rows are gone rather than silently editable.
    rerender(
      <ModelTable
        models={changes.at(-1)!}
        onChange={() => {}}
      />,
    );
    fireEvent.click(screen.getByLabelText('展开模型 1'));
    expect(screen.queryByLabelText('API 参数值 1')).toBeNull();
  });
});
