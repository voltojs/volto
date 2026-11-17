/**
 * ThinkingLevelsEditor: the per-model "tier → API parameter value" table.
 * The component is pure display + onChange (Task 6a); the ModelTable mount,
 * master-toggle linkage and reasoning auto-enable are covered in Task 6b.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { useState } from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
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

/** Click the master switch. `fireEvent` rather than `userEvent`: Base UI
 * forwards the switch's click to its hidden checkbox, and user-event also
 * replays a click through the wrapping <label>, which would toggle twice. */
function clickSwitch() {
  fireEvent.click(screen.getByRole('switch'));
}

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

describe('ThinkingLevelsEditor seeding', () => {
  it('renders rows for overridden ∪ supported levels with defaults as placeholders', () => {
    render(
      <ThinkingLevelsEditor value={undefined} levels={levelsSeed} onChange={() => {}} />,
    );
    // No override map = the master toggle starts off and the table collapsed;
    // enabling it seeds rows the same way mount does.
    clickSwitch();
    // off/minimal/xhigh/max are not overridden and only low/medium/high are
    // supported defaults besides off → 4 rows, in seed order.
    expect(screen.getAllByRole('combobox', { name: /档位 \d+$/ })).toHaveLength(4);
    // A default (non-overridden) tier shows its effective value as the
    // placeholder; an untouched box stays empty (= inherit).
    expect(screen.getByLabelText('API 参数值 1')).toHaveAttribute('placeholder', '关闭思考');
    expect(screen.getByLabelText('API 参数值 2')).toHaveAttribute('placeholder', 'custom');
    expect(screen.getByLabelText('API 参数值 3')).toHaveAttribute('placeholder', 'medium');
    expect(screen.getByLabelText('API 参数值 4')).toHaveAttribute('placeholder', 'high');
    for (const n of ['1', '2', '3', '4']) {
      expect(screen.getByLabelText(`API 参数值 ${n}`)).toHaveValue('');
    }
  });

  it('puts explicit overrides first and keeps their values in the boxes', () => {
    render(
      <ThinkingLevelsEditor
        value={{ high: 'turbo' }}
        levels={levelsSeed}
        onChange={() => {}}
      />,
    );
    const inputs = ['1', '2', '3', '4'].map((n) => screen.getByLabelText(`API 参数值 ${n}`));
    expect(inputs[0]).toHaveValue('turbo');
    // Remaining rows keep seed order: off, low, medium — as placeholders.
    expect(inputs[1]).toHaveAttribute('placeholder', '关闭思考');
    expect(inputs[2]).toHaveAttribute('placeholder', 'custom');
    expect(inputs[3]).toHaveAttribute('placeholder', 'medium');
  });

  it('falls back to all seven tiers when the model carries no levels info', () => {
    render(<ThinkingLevelsEditor value={undefined} levels={undefined} onChange={() => {}} />);
    clickSwitch();
    expect(screen.getAllByRole('combobox', { name: /档位 \d+$/ })).toHaveLength(7);
  });

  it('shows the localized off default placeholder only for the off tier', async () => {
    const user = userEvent.setup();
    render(
      <ThinkingLevelsEditor value={{ off: 'disabled' }} levels={levelsSeed} onChange={() => {}} />,
    );
    // An explicit override brings the off row first; its stored value wins
    // over the default placeholder.
    expect(screen.getByLabelText('API 参数值 1')).toHaveValue('disabled');
    // Switch the tier to one without an effective value: no placeholder at
    // all — the display logic never invents a literal.
    await user.click(screen.getByRole('combobox', { name: '档位 1' }));
    await user.click(await screen.findByRole('option', { name: 'xhigh' }));
    await waitFor(() =>
      expect(screen.getByLabelText('API 参数值 1')).toHaveAttribute('placeholder', ''),
    );
    // Back to off: the localized fallback appears.
    await user.click(screen.getByRole('combobox', { name: '档位 1' }));
    await user.click(await screen.findByRole('option', { name: 'off' }));
    await waitFor(() =>
      expect(screen.getByLabelText('API 参数值 1')).toHaveAttribute('placeholder', '关闭思考'),
    );
  });
});

describe('ThinkingLevelsEditor row semantics', () => {
  it('checking 不支持 writes null for that tier; unchecking deletes the key', async () => {
    const changes: Array<ThinkingLevelMap | undefined> = [];
    const user = userEvent.setup();
    render(
      <ThinkingLevelsEditor
        value={{ low: 'custom' }}
        levels={levelsSeed}
        onChange={(next) => changes.push(next)}
      />,
    );
    // Row order: low (override), then off, medium, high.
    const unsupported = screen.getByRole('checkbox', { name: '不支持 1' });
    await user.click(unsupported);
    expect(changes.at(-1)).toMatchObject({ low: null });
    await user.click(unsupported);
    // Unchecking leaves only the supported defaults, which carry no explicit
    // values — the map is empty, i.e. "no override" → undefined.
    expect(changes.at(-1)).toBeUndefined();
  });

  it('an empty value box deletes the key (inherit), distinct from null (unsupported)', async () => {
    const changes: Array<ThinkingLevelMap | undefined> = [];
    const user = userEvent.setup();
    render(
      <ThinkingLevelsEditor
        value={{ low: 'custom', high: null }}
        levels={levelsSeed}
        onChange={(next) => changes.push(next)}
      />,
    );
    // Row order: low (override), high (override, null), off, medium.
    await user.clear(screen.getByLabelText('API 参数值 1'));
    expect(changes.at(-1)).not.toHaveProperty('low');
    // The null row keeps its checkbox checked and shows an empty box.
    const nullInput = screen.getByLabelText('API 参数值 2');
    expect(nullInput).toHaveValue('');
    expect(nullInput).toHaveAttribute('disabled');
    expect(screen.getByRole('checkbox', { name: '不支持 2' })).toBeChecked();
  });

  it('deleting a row drops its key (back to inherit)', async () => {
    const changes: Array<ThinkingLevelMap | undefined> = [];
    const user = userEvent.setup();
    render(
      <ThinkingLevelsEditor
        value={{ low: 'custom' }}
        levels={levelsSeed}
        onChange={(next) => changes.push(next)}
      />,
    );
    await user.click(screen.getByRole('button', { name: '删除推理等级行 1' }));
    // Only the untouched supported defaults remain → empty map → undefined.
    expect(changes.at(-1)).toBeUndefined();
    expect(screen.queryByRole('combobox', { name: '档位 5' })).toBeNull();
  });

  it('tiers already used by other rows are disabled in every dropdown', async () => {
    const user = userEvent.setup();
    render(
      <ThinkingLevelsEditor value={undefined} levels={levelsSeed} onChange={() => {}} />,
    );
    clickSwitch();
    await user.click(screen.getByRole('combobox', { name: '档位 1' }));
    // Base UI items are focusable-when-disabled divs: data-disabled is the
    // readable surface (same assertion style as subagent-form.test.tsx).
    const lowOption = await screen.findByRole('option', { name: 'low' });
    expect(lowOption).toHaveAttribute('data-disabled');
  });

  it('添加档位 appends a row whose tier choice lands in the map', async () => {
    const changes: Array<ThinkingLevelMap | undefined> = [];
    const user = userEvent.setup();
    render(
      <ThinkingLevelsEditor
        value={{ low: 'custom' }}
        levels={levelsSeed}
        onChange={(next) => changes.push(next)}
      />,
    );
    await user.click(screen.getByRole('button', { name: '添加档位' }));
    await user.click(screen.getByRole('combobox', { name: '档位 5' }));
    await user.click(await screen.findByRole('option', { name: 'max' }));
    expect(changes.at(-1)).toMatchObject({ low: 'custom', max: 'max' });
  });

  it('never mutates the seed map in place', async () => {
    const seed: ThinkingLevelMap = { low: 'custom' };
    const user = userEvent.setup();
    render(<ThinkingLevelsEditor value={seed} levels={levelsSeed} onChange={() => {}} />);
    await user.type(screen.getByLabelText('API 参数值 2'), 'X');
    expect(seed).toEqual({ low: 'custom' });
  });
});

describe('ThinkingLevelsEditor master toggle', () => {
  /** The switch is a controlled surface: ModelTable remounts the editor when
   * the draft map goes undefined→map (its reasoning linkage), so each case
   * renders its own tree. jsdom's accessibility tree resolves the labelled
   * text and `aria-label` twice, hence the regex name. */
  it('renders checked when value is a non-empty map, unchecked when absent', () => {
    const { unmount } = render(
      <ThinkingLevelsEditor
        value={{ low: 'custom' }}
        levels={levelsSeed}
        onChange={() => {}}
      />,
    );
    expect(screen.getByRole('switch', { name: /启用推理等级覆盖/ })).toBeChecked();
    // The title and the switch label are separate strings so RTL queries
    // never collide (ruling from the 6a report).
    expect(screen.getByText('推理等级')).toBeTruthy();
    unmount();
    render(
      <ThinkingLevelsEditor value={undefined} levels={levelsSeed} onChange={() => {}} />,
    );
    expect(screen.getByRole('switch', { name: /启用推理等级覆盖/ })).not.toBeChecked();
  });

  it('turning off emits undefined and removes every row', () => {
    const changes: Array<ThinkingLevelMap | undefined> = [];
    render(
      <ThinkingLevelsEditor
        value={{ low: 'custom' }}
        levels={levelsSeed}
        onChange={(next) => changes.push(next)}
      />,
    );
    clickSwitch();
    // "off" means this model carries no override at all.
    expect(changes.at(-1)).toBeUndefined();
    expect(screen.queryByLabelText('API 参数值 1')).toBeNull();
    expect(screen.queryByRole('button', { name: '添加档位' })).toBeNull();
  });

  it('turning back on re-seeds the rows exactly like mount does', () => {
    const changes: Array<ThinkingLevelMap | undefined> = [];
    function Harness() {
      // Echoes the emitted map back through `value`, like ModelTable does.
      const [value, setValue] = useState<ThinkingLevelMap | undefined>({
        low: 'custom',
      });
      return (
        <ThinkingLevelsEditor
          value={value}
          levels={levelsSeed}
          onChange={(next) => {
            changes.push(next);
            setValue(next);
          }}
        />
      );
    }
    render(<Harness />);
    clickSwitch();
    clickSwitch();
    // Same seeding rule as mount: overrides first, then supported defaults —
    // low (override), off, medium, high; the emitted map still carries low.
    expect(screen.getAllByRole('combobox', { name: /档位 \d+$/ })).toHaveLength(4);
    expect(screen.getByLabelText('API 参数值 1')).toHaveValue('custom');
    expect(changes.at(-1)).toMatchObject({ low: 'custom' });
  });
});
