import { describe, expect, it } from 'vitest';
import { useState } from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
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
  { id: 'medium', supported: false, value: undefined, overridden: true },
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

describe('thinking levels editor mounted in the expand area', () => {
  /** A row whose editor seeds two tiers: low (overridden) and high (default). */
  const editorRow = () =>
    row({
      reasoning: true,
      thinkingLevelMap: { low: 'custom' },
      thinkingLevels: [
        { id: 'low', supported: true, value: 'custom', overridden: true },
        { id: 'high', supported: true, value: 'high', overridden: false },
      ],
    });

  it('renders the editor for an expanded row and hides it while collapsed', () => {
    render(<ModelTable models={[editorRow()]} onChange={() => {}} />);
    expect(screen.queryByText('推理等级')).toBeNull();
    fireEvent.click(screen.getByLabelText('展开模型 1'));
    expect(screen.getByText('推理等级')).toBeTruthy();
    // The seeded override shows in the first tier row's value box.
    expect(screen.getByLabelText('API 参数值 1')).toHaveValue('custom');
  });

  it('a non-empty emitted map flips reasoning off → true in the same patch and shows the hint', async () => {
    const user = userEvent.setup();
    const changes: DraftModel[][] = [];
    function Harness() {
      const [models, setModels] = useState([
        row({
          reasoning: false,
          thinkingLevels: [
            { id: 'low', supported: true, value: 'low', overridden: false },
          ],
        }),
      ]);
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
    // The master toggle starts off for a row without a stored map — turn the
    // section on first; the seed rows carry no explicit values, so the map
    // only becomes non-empty once the added tier's row is picked.
    await user.click(screen.getByRole('switch', { name: /启用推理等级覆盖/ }));
    await user.click(screen.getByRole('button', { name: '添加档位' }));
    await user.click(screen.getByRole('combobox', { name: '档位 2' }));
    await user.click(await screen.findByRole('option', { name: 'max' }));
    // The added tier's row seeds its value to the tier id itself, so the
    // emitted map is non-empty. (The untouched default row carries no key —
    // empty box = inherit.)
    const patched = changes.at(-1)?.[0];
    expect(patched?.reasoning).toBe(true);
    expect(patched?.thinkingLevelMap).toMatchObject({ max: 'max' });
    await waitFor(() =>
      expect(screen.getByText('已自动开启推理')).toBeTruthy(),
    );
  });

  it('greys the section while reasoning is off, and clears the grey once it is on', () => {
    // Two tables in one render: index 0 = reasoning off, index 1 = on. The
    // aria-label only exists to label this wrapper; the editor keeps its own
    // `推理等级` heading.
    render(
      <div>
        <ModelTable models={[row({ reasoning: false })]} onChange={() => {}} />
        <ModelTable models={[row({ clientKey: 'k2', reasoning: true })]} onChange={() => {}} />
      </div>,
    );
    const expandButtons = screen.getAllByLabelText('展开模型 1');
    fireEvent.click(expandButtons[0]!);
    fireEvent.click(expandButtons[1]!);
    const [offSection, onSection] = screen.getAllByLabelText('推理等级设置');
    expect(offSection).toHaveAttribute('aria-disabled', 'true');
    expect(offSection!.className).toContain('opacity-60');
    // `inert` is what actually stops edits: pi-ai ignores the map for a
    // non-reasoning model, so the section must not be operable at all. React
    // 19 serializes the boolean prop as the empty-string attribute form.
    expect(offSection!.hasAttribute('inert')).toBe(true);
    expect(onSection).not.toHaveAttribute('aria-disabled');
    expect(onSection!.hasAttribute('inert')).toBe(false);
    expect(onSection!.className).not.toContain('opacity-60');
  });

  it('turning reasoning back off keeps the stored map and leaves the section greyed', () => {
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
    fireEvent.click(screen.getByLabelText('支持推理 1'));
    const patched = changes.at(-1)?.[0];
    expect(patched?.reasoning).toBe(false);
    expect(patched?.thinkingLevelMap).toEqual({ low: 'custom' });
    const section = screen.getByLabelText('推理等级设置');
    expect(section).toHaveAttribute('aria-disabled', 'true');
    expect(section.className).toContain('opacity-60');
    expect(section.hasAttribute('inert')).toBe(true);
  });
});
