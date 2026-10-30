/**
 * The merged model + reasoning-effort control: both current values are
 * readable without opening anything, each drills into its own list, and
 * effort ids stay opaque (chosen by id, displayed by the server's name).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ModelSettingsPicker } from '@/components/chat/ModelSettingsPicker';
import { Dialog, DialogContent } from '@/components/ui/dialog';
import { useConfigStore, type Provider } from '@/stores/config-store';

// jsdom does not implement the pointer-capture APIs Base UI uses internally.
Element.prototype.hasPointerCapture ??= () => false;
Element.prototype.setPointerCapture ??= () => {};
Element.prototype.releasePointerCapture ??= () => {};
Element.prototype.scrollIntoView ??= () => {};

const PROVIDER: Provider = {
  kind: 'custom',
  id: 'v1',
  name: 'Xiaomi',
  baseURL: 'https://example.com/v1',
  apiKeyMasked: null,
  models: [
    { id: 'm1', name: 'MiMo-V2.5', code: 'mimo-v2.5' },
    { id: 'm2', name: 'MiMo-V2.5-Pro', code: 'mimo-v2.5-pro' },
  ],
};

const EFFORTS = [
  { id: 'low', name: 'Low' },
  { id: 'high', name: 'High' },
];

beforeEach(() => {
  useConfigStore.setState({
    providers: [PROVIDER],
    catalogProviders: [],
    loaded: true,
    error: null,
  });
});

function setup(overrides: Partial<Parameters<typeof ModelSettingsPicker>[0]> = {}) {
  const onModelChange = vi.fn();
  const onEffortChange = vi.fn();
  render(
    <ModelSettingsPicker
      providerId="v1"
      modelId="m2"
      onModelChange={onModelChange}
      efforts={EFFORTS}
      effort="low"
      onEffortChange={onEffortChange}
      {...overrides}
    />,
  );
  return {
    onModelChange,
    onEffortChange,
    user: userEvent.setup({ pointerEventsCheck: 0 }),
  };
}

describe('ModelSettingsPicker', () => {
  it('shows both current values on the trigger, and again in the root pane', async () => {
    const { user } = setup();

    const trigger = screen.getByRole('button', { name: /模型与推理等级/ });
    expect(trigger).toHaveTextContent('MiMo-V2.5-Pro');
    expect(trigger).toHaveTextContent('Low');

    await user.click(trigger);
    // Root pane: one row per setting, each echoing its current value.
    expect(await screen.findByText('模型')).toBeInTheDocument();
    expect(screen.getByText('推理等级')).toBeInTheDocument();
    // The model list itself is not shown until the row is opened.
    expect(screen.queryByText('MiMo-V2.5')).not.toBeInTheDocument();
  });

  it('drills into the model list, reports the raw id, and returns to the root', async () => {
    const { user, onModelChange } = setup();

    await user.click(screen.getByRole('button', { name: /模型与推理等级/ }));
    await user.click(await screen.findByText('模型'));
    await user.click(await screen.findByText('MiMo-V2.5'));

    expect(onModelChange).toHaveBeenCalledWith('v1', 'm1');
    // Back at the root rather than closed, so the effort can be changed next.
    expect(await screen.findByText('推理等级')).toBeInTheDocument();
  });

  it('invokes onEffortChange with the raw effort id, not its display name', async () => {
    const { user, onEffortChange } = setup();

    await user.click(screen.getByRole('button', { name: /模型与推理等级/ }));
    await user.click(await screen.findByText('推理等级'));
    await user.click(await screen.findByText('High'));

    expect(onEffortChange).toHaveBeenCalledWith('high');
  });

  it('omits the reasoning row entirely when the model declares no efforts', async () => {
    const { user } = setup({ efforts: [], effort: undefined });

    const trigger = screen.getByRole('button', { name: /模型与推理等级/ });
    expect(trigger).toHaveTextContent('MiMo-V2.5-Pro');

    await user.click(trigger);
    expect(await screen.findByText('模型')).toBeInTheDocument();
    // Not a disabled row, not an empty list — absent.
    expect(screen.queryByText('推理等级')).not.toBeInTheDocument();
  });

  it('says a model reference is stale rather than naming some other model', () => {
    setup({ modelId: 'deleted-model', efforts: [], effort: undefined });
    expect(
      screen.getByRole('button', { name: /模型与推理等级/ }),
    ).toHaveTextContent('模型已失效');
  });

  it('reopens at the root after being closed mid-drill', async () => {
    const { user } = setup();
    const trigger = screen.getByRole('button', { name: /模型与推理等级/ });

    await user.click(trigger);
    await user.click(await screen.findByText('模型'));
    expect(await screen.findByText('MiMo-V2.5')).toBeInTheDocument();

    await user.keyboard('{Escape}');
    await user.click(trigger);

    expect(await screen.findByText('推理等级')).toBeInTheDocument();
    expect(screen.queryByText('MiMo-V2.5')).not.toBeInTheDocument();
  });
});

/** Parses a Tailwind z token (`z-50`, `z-[60]`) into its numeric level. */
function zToken(el: Element): number {
  const match = /(?:^|\s)z-(?:\[(\d+)\]|(\d+))(?:\s|$)/.exec(el.className);
  return match ? Number(match[1] ?? match[2]) : NaN;
}

describe('ModelSettingsPicker placement', () => {
  it('paints its popup above the modal dialog content when the host asks for it', async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    render(
      <Dialog open onOpenChange={() => {}}>
        <DialogContent>
          <ModelSettingsPicker
            providerId="v1"
            modelId="m2"
            onModelChange={vi.fn()}
            efforts={EFFORTS}
            effort={undefined}
            onEffortChange={vi.fn()}
            zIndexClassName="z-[60]"
          />
        </DialogContent>
      </Dialog>,
    );
    await user.click(screen.getByRole('button', { name: /模型与推理等级/ }));
    expect(await screen.findByText('模型')).toBeInTheDocument();

    // jsdom paints nothing, so the stacking contract is pinned as the z
    // tokens themselves. The stacking unit is Base UI's absolutely
    // positioned Positioner: the popup inside it is static, whose z-index
    // never joins paint order — a token there is a no-op (the bug's real
    // shape). A unit that does not declare a level above the dialog's
    // z-50 paints under the dialog and reads as "click does nothing", so
    // the host passes the layer in via `zIndexClassName`.
    const popup = document.querySelector('[data-slot="popover-content"]');
    const dialogContent = document.querySelector(
      '[data-slot="dialog-content"]',
    );
    expect(popup).not.toBeNull();
    expect(dialogContent).not.toBeNull();
    const positioner = popup!.parentElement!;
    expect(zToken(positioner)).toBeGreaterThan(zToken(dialogContent!));
  });

  it('defaults to the dialog-level z-50 layer when the host passes none', async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    render(
      <ModelSettingsPicker
        providerId="v1"
        modelId="m2"
        onModelChange={vi.fn()}
        efforts={EFFORTS}
        effort={undefined}
        onEffortChange={vi.fn()}
      />,
    );
    await user.click(screen.getByRole('button', { name: /模型与推理等级/ }));
    expect(await screen.findByText('模型')).toBeInTheDocument();
    // The shared popover keeps its stock layer: only hosts that opt in get
    // a popup above their dialogs (ChatPanel & friends stay untouched).
    const popup = document.querySelector('[data-slot="popover-content"]');
    expect(zToken(popup!.parentElement!)).toBe(50);
  });

  it('honors a zIndexClassName override on the stacking unit', async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    render(
      <ModelSettingsPicker
        providerId="v1"
        modelId="m2"
        onModelChange={vi.fn()}
        efforts={EFFORTS}
        effort={undefined}
        onEffortChange={vi.fn()}
        zIndexClassName="z-[70]"
      />,
    );
    await user.click(screen.getByRole('button', { name: /模型与推理等级/ }));
    expect(await screen.findByText('模型')).toBeInTheDocument();
    // An off-default value proves the level comes from the caller's prop,
    // not from a hard-coded class inside the shared component.
    const popup = document.querySelector('[data-slot="popover-content"]');
    expect(zToken(popup!.parentElement!)).toBe(70);
  });

  it('opens below the trigger by default', async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    render(
      <ModelSettingsPicker
        providerId="v1"
        modelId="m2"
        onModelChange={vi.fn()}
        efforts={EFFORTS}
        effort={undefined}
        onEffortChange={vi.fn()}
      />,
    );
    await user.click(screen.getByRole('button', { name: /模型与推理等级/ }));
    expect(await screen.findByText('模型')).toBeInTheDocument();
    // The composer's default placement stays as it was.
    expect(
      document.querySelector('[data-slot="popover-content"]'),
    ).toHaveAttribute('data-side', 'bottom');
  });

  it('honors a side override so hosts can keep the popup clear of actions', async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    render(
      <ModelSettingsPicker
        providerId="v1"
        modelId="m2"
        onModelChange={vi.fn()}
        efforts={EFFORTS}
        effort={undefined}
        onEffortChange={vi.fn()}
        side="top"
      />,
    );
    await user.click(screen.getByRole('button', { name: /模型与推理等级/ }));
    expect(await screen.findByText('模型')).toBeInTheDocument();
    expect(
      document.querySelector('[data-slot="popover-content"]'),
    ).toHaveAttribute('data-side', 'top');
  });
});
