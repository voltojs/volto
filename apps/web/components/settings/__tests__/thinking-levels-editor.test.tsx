/**
 * ThinkingLevelsEditor: the per-model "tier → API parameter value" table.
 * The table is the single source of which tiers a model offers — there is no
 * master toggle and no "unsupported" state any more. The ModelTable mount is
 * covered in model-table-input.test.tsx.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { StrictMode } from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ThinkingLevelsEditor } from '../ThinkingLevelsEditor';
import type { ThinkingLevelInfo, ThinkingLevelMap } from '@/lib/config-api';

// jsdom lacks the pointer-capture / scroll APIs Base UI's Select uses.
Element.prototype.hasPointerCapture ??= () => false;
Element.prototype.setPointerCapture ??= () => {};
Element.prototype.releasePointerCapture ??= () => {};
Element.prototype.scrollIntoView ??= () => {};

afterEach(() => {
  vi.restoreAllMocks();
});

/** A resolved `reasoning.levels` array as `GET /providers` sends it. */
const levelsSeed: ThinkingLevelInfo[] = [
  { id: 'off', supported: true, overridden: false },
  { id: 'minimal', supported: false, overridden: false },
  { id: 'low', supported: true, value: 'custom', overridden: true },
  { id: 'medium', supported: true, value: 'medium', overridden: false },
  { id: 'high', supported: true, value: 'high', overridden: false },
  { id: 'xhigh', supported: false, overridden: false },
  { id: 'max', supported: false, overridden: false },
];

/** The value boxes in DOM order. */
function valueBoxes(): HTMLInputElement[] {
  return screen.getAllByLabelText(/^API 参数值 \d+$/) as HTMLInputElement[];
}

describe('ThinkingLevelsEditor seeding', () => {
  it('lists exactly the tiers pi-ai reports as supported, with their real wire values', () => {
    render(
      <ThinkingLevelsEditor value={undefined} levels={levelsSeed} onChange={() => {}} />,
    );
    // Supported and listed: low / medium / high. off is supported but the chat
    // picker never offers it unless it carries a stored override; minimal,
    // xhigh and max are not supported.
    const boxes = valueBoxes();
    expect(boxes.map((box) => box.value)).toEqual(['custom', 'medium', 'high']);
    // 所见即所发: every box carries the actual wire value, never a placeholder.
    for (const box of boxes) {
      expect(box).not.toHaveAttribute('placeholder');
    }
    expect(screen.getByRole('combobox', { name: '档位 1' }).textContent).toContain('low');
    expect(screen.getByRole('combobox', { name: '档位 2' }).textContent).toContain('medium');
    expect(screen.getByRole('combobox', { name: '档位 3' }).textContent).toContain('high');
  });

  it('keeps stored string overrides and drops stored nulls, in canonical tier order', () => {
    render(
      <ThinkingLevelsEditor
        value={{ off: 'none', minimal: null, high: 'turbo', max: 'maxed' }}
        levels={levelsSeed}
        onChange={() => {}}
      />,
    );
    // off is listed because of its override; minimal is excluded although it
    // is supported-by-default nowhere here — its stored null wins either way.
    const boxes = valueBoxes();
    expect(boxes.map((box) => box.value)).toEqual([
      'none', // off
      'custom', // low (reported value)
      'medium', // medium (reported value)
      'turbo', // high (stored override wins over the reported value)
      'maxed', // max (stored override, unsupported by the catalog)
    ]);
    expect(screen.getByRole('combobox', { name: '档位 4' }).textContent).toContain('high');
    expect(screen.getByRole('combobox', { name: '档位 5' }).textContent).toContain('max');
  });

  it('falls back to the tier id when a supported tier has no reported value', () => {
    render(
      <ThinkingLevelsEditor
        value={undefined}
        levels={[
          { id: 'minimal', supported: true, overridden: false },
          { id: 'low', supported: true, overridden: false },
        ]}
        onChange={() => {}}
      />,
    );
    expect(valueBoxes().map((box) => box.value)).toEqual(['minimal', 'low']);
  });
});

describe('ThinkingLevelsEditor row semantics', () => {
  it('deleting a minimal/low/medium/high row emits null for it and keeps the other listed values', async () => {
    const changes: Array<ThinkingLevelMap | undefined> = [];
    const user = userEvent.setup();
    render(
      <ThinkingLevelsEditor
        value={undefined}
        levels={levelsSeed}
        onChange={(next) => changes.push(next)}
      />,
    );
    // Rows: low / medium / high — delete medium (row 2).
    await user.click(screen.getByRole('button', { name: '删除推理等级行 2' }));
    expect(changes.at(-1)).toMatchObject({
      low: 'custom',
      medium: null,
      high: 'high',
      // minimal was never listed either: it is a default-supported tier, so
      // it is encoded as "not offered" too.
      minimal: null,
    });
    // off/xhigh/max are not default-supported: never nulled when unlisted.
    expect(changes.at(-1)).not.toHaveProperty('off');
    expect(changes.at(-1)).not.toHaveProperty('xhigh');
    expect(changes.at(-1)).not.toHaveProperty('max');
  });

  it('deleting nothing and editing nothing emits undefined', () => {
    const onChange = vi.fn();
    render(
      <ThinkingLevelsEditor value={undefined} levels={levelsSeed} onChange={onChange} />,
    );
    // Seeding is not an edit: the draft keeps no stored override at all, so
    // pi-ai's own defaults stay in force.
    expect(onChange).not.toHaveBeenCalled();
    expect(valueBoxes()).toHaveLength(3);
  });

  it('adding a tier appends it with its id as the value', async () => {
    const changes: Array<ThinkingLevelMap | undefined> = [];
    const user = userEvent.setup();
    render(
      <ThinkingLevelsEditor
        value={undefined}
        levels={levelsSeed}
        onChange={(next) => changes.push(next)}
      />,
    );
    await user.click(screen.getByRole('button', { name: '添加档位' }));
    // First tier not listed yet: off.
    expect(changes.at(-1)).toMatchObject({
      off: 'off',
      low: 'custom',
      medium: 'medium',
      high: 'high',
    });
    expect(valueBoxes()[3]).toHaveValue('off');
  });

  it('emptying a value box refills the tier id immediately', () => {
    const changes: Array<ThinkingLevelMap | undefined> = [];
    render(
      <ThinkingLevelsEditor
        value={{ low: 'custom' }}
        levels={levelsSeed}
        onChange={(next) => changes.push(next)}
      />,
    );
    const box = screen.getByLabelText('API 参数值 1') as HTMLInputElement;
    expect(box).toHaveValue('custom');
    fireEvent.change(box, { target: { value: '' } });
    // The box never stays empty: it shows exactly what will be sent.
    expect(box).toHaveValue('low');
    expect(changes.at(-1)).toMatchObject({ low: 'low' });
  });

  it('has no master switch and no unsupported checkbox any more', () => {
    render(
      <ThinkingLevelsEditor value={undefined} levels={levelsSeed} onChange={() => {}} />,
    );
    expect(screen.queryByRole('switch')).toBeNull();
    expect(screen.queryByRole('checkbox')).toBeNull();
    expect(screen.queryByText('不支持')).toBeNull();
    expect(screen.queryByText(/启用推理等级覆盖/)).toBeNull();
  });

  it('tiers already used by other rows are disabled in every dropdown', async () => {
    const user = userEvent.setup();
    render(
      <ThinkingLevelsEditor value={undefined} levels={levelsSeed} onChange={() => {}} />,
    );
    await user.click(screen.getByRole('combobox', { name: '档位 1' }));
    // Base UI items are focusable-when-disabled divs: data-disabled is the
    // readable surface (same assertion style as subagent-form.test.tsx).
    const mediumOption = await screen.findByRole('option', { name: 'medium' });
    expect(mediumOption).toHaveAttribute('data-disabled');
  });

  it('hides 添加档位 once all seven tiers have rows', () => {
    render(
      <ThinkingLevelsEditor
        value={{
          off: 'off-value',
          minimal: 'minimal-value',
          low: 'low-value',
          medium: 'medium-value',
          high: 'high-value',
          xhigh: 'xhigh-value',
          max: 'max-value',
        }}
        levels={levelsSeed}
        onChange={() => {}}
      />,
    );
    expect(valueBoxes()).toHaveLength(7);
    expect(screen.queryByRole('button', { name: '添加档位' })).toBeNull();
  });

  it('fires onChange once per edit under StrictMode', () => {
    // The parent patch must run once, not once per updater invocation:
    // StrictMode deliberately double-invokes state updaters.
    const changes: Array<ThinkingLevelMap | undefined> = [];
    render(
      <StrictMode>
        <ThinkingLevelsEditor
          value={{ low: 'custom' }}
          levels={levelsSeed}
          onChange={(next) => changes.push(next)}
        />
      </StrictMode>,
    );
    fireEvent.change(screen.getByLabelText('API 参数值 1'), {
      target: { value: 'edited' },
    });
    expect(changes).toEqual([
      { low: 'edited', minimal: null, medium: 'medium', high: 'high' },
    ]);
  });

  it('never mutates the seed map in place', () => {
    const seed: ThinkingLevelMap = { low: 'custom' };
    render(<ThinkingLevelsEditor value={seed} levels={levelsSeed} onChange={() => {}} />);
    fireEvent.change(screen.getByLabelText('API 参数值 2'), {
      target: { value: 'mediumX' },
    });
    expect(seed).toEqual({ low: 'custom' });
  });
});
