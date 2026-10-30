/**
 * Routing tier CRUD panel (SubagentsPanel-style two-state UI): the list
 * shows one card per tier (id / label / description, target model in the
 * ModelSettingsPicker trigger shape, reasoning effort), and create/edit
 * replace the whole list with a form whose target + effort come from
 * ModelSettingsPicker. Edits are persisted by a full-table PUT; a 409
 * reference conflict surfaces inline in the list without losing it.
 */

import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { RoutingTiersPanel } from '../RoutingTiersPanel';
import { useConfigStore, type Provider } from '@/stores/config-store';
import { SERVER_URL } from '@/lib/agent-config';
import type { RoutingTier } from '@/lib/routing-tiers-api';

// jsdom does not implement the pointer-capture / scroll APIs Base UI's
// Select / Popover use internally; stub them so the popups can open in tests.
Element.prototype.hasPointerCapture ??= () => false;
Element.prototype.setPointerCapture ??= () => {};
Element.prototype.releasePointerCapture ??= () => {};
Element.prototype.scrollIntoView ??= () => {};

const PROVIDERS: Provider[] = [
  {
    kind: 'custom',
    id: 'v1',
    name: 'Xiaomi',
    baseURL: null,
    apiKeyMasked: null,
    models: [
      { id: 'm1', name: 'MiMo-V2.5', code: 'mimo-v2.5' },
      {
        id: 'm2',
        name: 'MiMo-V2.5-Pro',
        code: 'mimo-v2.5-pro',
        reasoning: {
          efforts: [
            { id: 'low', name: 'Low' },
            { id: 'high', name: 'High' },
          ],
          defaultEffort: 'low',
        },
      },
    ],
  },
  {
    kind: 'custom',
    id: 'v2',
    name: 'Anthropic',
    baseURL: null,
    apiKeyMasked: null,
    models: [{ id: 'c1', name: 'Claude X', code: 'claude-x' }],
  },
];

const TIERS: RoutingTier[] = [
  {
    id: 'premium',
    label: '最强',
    description: '复杂任务',
    target: { providerId: 'v1', modelId: 'm2' },
  },
  {
    id: 'economy',
    label: '省成本',
    description: '日常任务',
    target: { providerId: 'v1', modelId: 'm1' },
  },
];

interface FetchCall {
  method: string;
  path: string;
  body: unknown;
}

function stubFetch(
  routes: Record<string, () => { status: number; body: unknown }>,
): FetchCall[] {
  const calls: FetchCall[] = [];
  vi.stubGlobal(
    'fetch',
    async (
      input: string | URL | Request,
      init?: { method?: string; body?: string },
    ) => {
      const method = init?.method ?? 'GET';
      const path = new URL(String(input), 'http://localhost').pathname;
      const body = init?.body === undefined ? undefined : JSON.parse(init.body);
      calls.push({ method, path, body });
      const route = routes[`${method} ${path}`];
      if (route === undefined) throw new Error(`Unstubbed route: ${method} ${path}`);
      const { status, body: responseBody } = route();
      return new Response(JSON.stringify(responseBody), { status });
    },
  );
  return calls;
}

type User = ReturnType<typeof userEvent.setup>;

/** Open the picker and drill into the model pane to choose one model. */
async function pickModel(user: User, name: string) {
  await user.click(screen.getByRole('button', { name: /模型与推理等级/ }));
  await user.click(await screen.findByText('模型'));
  await user.click(await screen.findByText(name));
}

/** From the picker's root pane, drill into the reasoning pane to choose one. */
async function pickEffort(user: User, name: string) {
  await user.click(await screen.findByText('推理等级'));
  await user.click(await screen.findByText(name));
}

beforeEach(() => {
  useConfigStore.setState({
    providers: PROVIDERS,
    catalogProviders: [],
    loaded: true,
    error: null,
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('RoutingTiersPanel', () => {
  it('渲染即拉取并列出档位卡片：id/label/description 与目标模型展示（mock fetch）', async () => {
    const calls = stubFetch({
      [`GET ${SERVER_URL}/config/routing-tiers`]: () => ({
        status: 200,
        body: { tiers: TIERS },
      }),
    });
    render(<RoutingTiersPanel />);

    // Every tier is a card row: identity + copy + resolved target model.
    const id = await screen.findByText('premium');
    expect(id).toHaveClass('font-medium');
    expect(screen.getByText('最强')).toBeInTheDocument();
    expect(screen.getByText('复杂任务')).toBeInTheDocument();
    expect(screen.getByText('MiMo-V2.5-Pro')).toHaveClass('font-mono');
    expect(screen.getByText('economy')).toBeInTheDocument();
    expect(screen.getByText('省成本')).toBeInTheDocument();
    expect(screen.getByText('日常任务')).toBeInTheDocument();
    expect(screen.getByText('MiMo-V2.5')).toBeInTheDocument();
    expect(calls).toEqual([
      {
        method: 'GET',
        path: `${SERVER_URL}/config/routing-tiers`,
        body: undefined,
      },
    ]);
  });

  it('列表卡片：未指派档位显示「未配置模型」，reasoningEffort 以 mono 小字显示', async () => {
    stubFetch({
      [`GET ${SERVER_URL}/config/routing-tiers`]: () => ({
        status: 200,
        body: {
          tiers: [
            {
              id: 'draft',
              label: '草稿',
              description: '待定',
              target: null,
            },
            {
              id: 'premium',
              label: '最强',
              description: '复杂任务',
              target: { providerId: 'v1', modelId: 'm2' },
              reasoningEffort: 'high',
            },
          ] satisfies RoutingTier[],
        },
      }),
    });
    render(<RoutingTiersPanel />);

    expect(await screen.findByText('draft')).toBeInTheDocument();
    // Unassigned tiers say so instead of naming a phantom model.
    expect(screen.getByText('未配置模型')).toBeInTheDocument();
    // The effort id is opaque: display the model's declared name for it.
    const effort = screen.getByText('High');
    expect(effort).toHaveClass('font-mono');
    expect(effort).toHaveClass('text-xs');
  });

  it('新增档位打开表单，填 id/label/description 并在 ModelSettingsPicker 选模型，保存发起 PUT 且 body 含新档位', async () => {
    const calls = stubFetch({
      [`GET ${SERVER_URL}/config/routing-tiers`]: () => ({
        status: 200,
        body: { tiers: [] },
      }),
      [`PUT ${SERVER_URL}/config/routing-tiers`]: () => ({
        status: 200,
        body: { tiers: [] },
      }),
    });
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    render(<RoutingTiersPanel />);
    expect(await screen.findByText('还没有模型路由档位。')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: '新增档位' }));
    await user.type(screen.getByLabelText('id'), 'fast');
    await user.type(screen.getByLabelText('label'), '快速');
    await user.type(screen.getByLabelText('description'), '省成本的小任务');
    await pickModel(user, 'MiMo-V2.5');

    await user.click(screen.getByRole('button', { name: '保存' }));

    // Full replace: the request body is the bare tier array (no {tiers}
    // wrapper) and it carries the new row end to end.
    await waitFor(() => {
      expect(calls.some((c) => c.method === 'PUT')).toBe(true);
    });
    const put = calls.find((c) => c.method === 'PUT');
    expect(put?.path).toBe(`${SERVER_URL}/config/routing-tiers`);
    expect(put?.body).toEqual([
      {
        id: 'fast',
        label: '快速',
        description: '省成本的小任务',
        target: { providerId: 'v1', modelId: 'm1' },
      },
    ]);
  });

  it('表单的 ModelSettingsPicker 选中另一 provider 的模型后保存，PUT body target 为该 {providerId, modelId}', async () => {
    const calls = stubFetch({
      [`GET ${SERVER_URL}/config/routing-tiers`]: () => ({
        status: 200,
        body: { tiers: [TIERS[0]] },
      }),
      [`PUT ${SERVER_URL}/config/routing-tiers`]: () => ({
        status: 200,
        body: { tiers: [] },
      }),
    });
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    render(<RoutingTiersPanel />);
    await screen.findByText('premium');

    await user.click(screen.getByRole('button', { name: '编辑 premium' }));
    await pickModel(user, 'Claude X');
    expect(
      screen.getByRole('button', { name: /模型与推理等级/ }),
    ).toHaveTextContent('Claude X');

    await user.click(screen.getByRole('button', { name: '保存' }));

    await waitFor(() => {
      expect(calls.some((c) => c.method === 'PUT')).toBe(true);
    });
    const put = calls.find((c) => c.method === 'PUT');
    expect(put?.body).toEqual([
      {
        id: 'premium',
        label: '最强',
        description: '复杂任务',
        target: { providerId: 'v2', modelId: 'c1' },
      },
    ]);
  });

  it('选模型后选推理等级 → PUT body 含 reasoningEffort', async () => {
    const calls = stubFetch({
      [`GET ${SERVER_URL}/config/routing-tiers`]: () => ({
        status: 200,
        body: { tiers: [TIERS[1]] },
      }),
      [`PUT ${SERVER_URL}/config/routing-tiers`]: () => ({
        status: 200,
        body: { tiers: [] },
      }),
    });
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    render(<RoutingTiersPanel />);
    await screen.findByText('economy');

    await user.click(screen.getByRole('button', { name: '编辑 economy' }));
    await pickModel(user, 'MiMo-V2.5-Pro');
    await pickEffort(user, 'High');
    // The chosen effort reads back by its declared name, not its raw id.
    expect(
      screen.getByRole('button', { name: /模型与推理等级/ }),
    ).toHaveTextContent('High');

    await user.click(screen.getByRole('button', { name: '保存' }));

    await waitFor(() => {
      expect(calls.some((c) => c.method === 'PUT')).toBe(true);
    });
    const put = calls.find((c) => c.method === 'PUT');
    expect(put?.body).toEqual([
      {
        id: 'economy',
        label: '省成本',
        description: '日常任务',
        target: { providerId: 'v1', modelId: 'm2' },
        reasoningEffort: 'high',
      },
    ]);
  });

  it('更换模型后 effort 复位，PUT body 不再携带 reasoningEffort', async () => {
    const calls = stubFetch({
      [`GET ${SERVER_URL}/config/routing-tiers`]: () => ({
        status: 200,
        body: {
          tiers: [
            {
              id: 'premium',
              label: '最强',
              description: '复杂任务',
              target: { providerId: 'v1', modelId: 'm2' },
              reasoningEffort: 'high',
            },
          ] satisfies RoutingTier[],
        },
      }),
      [`PUT ${SERVER_URL}/config/routing-tiers`]: () => ({
        status: 200,
        body: { tiers: [] },
      }),
    });
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    render(<RoutingTiersPanel />);
    await screen.findByText('premium');

    await user.click(screen.getByRole('button', { name: '编辑 premium' }));
    expect(
      screen.getByRole('button', { name: /模型与推理等级/ }),
    ).toHaveTextContent('High');
    // Changing the model clears the effort that belonged to the old one.
    await pickModel(user, 'MiMo-V2.5');

    await user.click(screen.getByRole('button', { name: '保存' }));

    await waitFor(() => {
      expect(calls.some((c) => c.method === 'PUT')).toBe(true);
    });
    const put = calls.find((c) => c.method === 'PUT');
    expect(put?.body).toEqual([
      {
        id: 'premium',
        label: '最强',
        description: '复杂任务',
        target: { providerId: 'v1', modelId: 'm1' },
      },
    ]);
    expect(
      (put?.body as Array<Record<string, unknown>>)[0],
    ).not.toHaveProperty('reasoningEffort');
  });

  it('未指派档位的表单 picker trigger 显示「未配置模型」', async () => {
    stubFetch({
      [`GET ${SERVER_URL}/config/routing-tiers`]: () => ({
        status: 200,
        body: {
          tiers: [
            { id: 'draft', label: '草稿', description: '待定', target: null },
          ] satisfies RoutingTier[],
        },
      }),
    });
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    render(<RoutingTiersPanel />);
    await screen.findByText('draft');

    await user.click(screen.getByRole('button', { name: '编辑 draft' }));

    expect(
      screen.getByRole('button', { name: /模型与推理等级/ }),
    ).toHaveTextContent('未配置模型');
  });

  it('编辑按钮以表单整体替换列表，取消返回列表且不改草稿', async () => {
    const calls = stubFetch({
      [`GET ${SERVER_URL}/config/routing-tiers`]: () => ({
        status: 200,
        body: { tiers: TIERS },
      }),
    });
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    render(<RoutingTiersPanel />);
    await screen.findByText('premium');

    await user.click(screen.getByRole('button', { name: '编辑 premium' }));

    // The form replaces the whole list, prefilled from the row it edits.
    expect(screen.queryByText('economy')).toBeNull();
    expect(screen.queryByRole('button', { name: '新增档位' })).toBeNull();
    expect(screen.getByDisplayValue('premium')).toBeInTheDocument();
    expect(screen.getByDisplayValue('最强')).toBeInTheDocument();
    expect(screen.getByDisplayValue('复杂任务')).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: /模型与推理等级/ }),
    ).toHaveTextContent('MiMo-V2.5-Pro');
    expect(screen.getByRole('button', { name: '保存' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '取消' })).toBeInTheDocument();

    const label = screen.getByLabelText('label');
    await user.clear(label);
    await user.type(label, '改了');
    await user.click(screen.getByRole('button', { name: '取消' }));

    // Cancel discards the edit: the draft still shows the saved values.
    expect(screen.getByText('premium')).toBeInTheDocument();
    expect(screen.getByText('最强')).toBeInTheDocument();
    expect(screen.queryByText('改了')).toBeNull();
    expect(calls.every((c) => c.method === 'GET')).toBe(true);
  });

  it('表单保存遇 400 时表单内联错误并保留编辑', async () => {
    stubFetch({
      [`GET ${SERVER_URL}/config/routing-tiers`]: () => ({
        status: 200,
        body: { tiers: [TIERS[0]] },
      }),
      [`PUT ${SERVER_URL}/config/routing-tiers`]: () => ({
        status: 400,
        body: {
          error:
            'routing tier "premium" targets unknown model: {"providerId":"v1","modelId":"m9"}',
        },
      }),
    });
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    render(<RoutingTiersPanel />);
    await screen.findByText('premium');

    await user.click(screen.getByRole('button', { name: '编辑 premium' }));
    const label = screen.getByLabelText('label');
    await user.clear(label);
    await user.type(label, '改了');
    await user.click(screen.getByRole('button', { name: '保存' }));

    // A shape/resolve failure names the tier: keep the form open so the row
    // can be fixed instead of dropping the user back to a generic list.
    expect(
      await screen.findByText(/routing tier "premium" targets unknown model/),
    ).toBeInTheDocument();
    expect(screen.getByDisplayValue('改了')).toBeInTheDocument();
  });

  it('表单保存后列表行显示编辑后的值，旧值消失', async () => {
    stubFetch({
      [`GET ${SERVER_URL}/config/routing-tiers`]: () => ({
        status: 200,
        body: { tiers: TIERS },
      }),
      [`PUT ${SERVER_URL}/config/routing-tiers`]: () => ({
        status: 200,
        body: { tiers: [] },
      }),
    });
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    render(<RoutingTiersPanel />);
    await screen.findByText('premium');

    await user.click(screen.getByRole('button', { name: '编辑 premium' }));
    const label = screen.getByLabelText('label');
    await user.clear(label);
    await user.type(label, '顶配');
    await user.click(screen.getByRole('button', { name: '保存' }));

    // The list rows must show what was just saved — the row is rendered
    // from the draft, so a save that never writes back leaves the old
    // values on screen (reported bug: "保存后列表不刷新").
    expect(await screen.findByText('顶配')).toBeInTheDocument();
    expect(screen.queryByText('最强')).toBeNull();
  });

  it('新增档位保存后列表出现新行', async () => {
    stubFetch({
      [`GET ${SERVER_URL}/config/routing-tiers`]: () => ({
        status: 200,
        body: { tiers: [] },
      }),
      [`PUT ${SERVER_URL}/config/routing-tiers`]: () => ({
        status: 200,
        body: { tiers: [] },
      }),
    });
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    render(<RoutingTiersPanel />);
    expect(await screen.findByText('还没有模型路由档位。')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: '新增档位' }));
    await user.type(screen.getByLabelText('id'), 'fast');
    await user.type(screen.getByLabelText('label'), '快速');
    await user.click(screen.getByRole('button', { name: '保存' }));

    // Same write-back contract as editing: the new row lands in the list.
    expect(await screen.findByText('fast')).toBeInTheDocument();
    expect(screen.getByText('快速')).toBeInTheDocument();
    expect(screen.queryByText('还没有模型路由档位。')).toBeNull();
  });

  it('表单内 picker popup 向上弹出，不遮挡保存/取消', async () => {
    stubFetch({
      [`GET ${SERVER_URL}/config/routing-tiers`]: () => ({
        status: 200,
        body: { tiers: [TIERS[0]] },
      }),
    });
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    render(<RoutingTiersPanel />);
    await screen.findByText('premium');

    await user.click(screen.getByRole('button', { name: '编辑 premium' }));
    await user.click(screen.getByRole('button', { name: /模型与推理等级/ }));
    expect(await screen.findByText('模型')).toBeInTheDocument();

    // jsdom lays nothing out, so the "never covers the submit row" contract
    // is pinned as the popup's side: opening upward lands it over the form
    // fields, while the default downward side covered 保存/取消 (bug report).
    // The layer is pinned the same way: the form is hosted inside the modal
    // settings dialog, so it passes the above-dialog token in explicitly
    // (a full literal — Tailwind's scanner must see the whole class name).
    const popup = document.querySelector('[data-slot="popover-content"]');
    expect(popup).not.toBeNull();
    expect(popup).toHaveAttribute('data-side', 'top');
    expect(popup!.parentElement!.className).toContain('z-[60]');
  });

  it('删除被引用档位：PUT reject 409 body {error, references} → 面板展示「被 XXX 引用，无法删除」且不丢本地列表', async () => {
    stubFetch({
      [`GET ${SERVER_URL}/config/routing-tiers`]: () => ({
        status: 200,
        body: { tiers: TIERS },
      }),
      [`PUT ${SERVER_URL}/config/routing-tiers`]: () => ({
        status: 409,
        body: {
          error:
            'cannot remove routing tier(s) still referenced by agent definitions: premium',
          references: [{ name: 'deploy-bot', scope: 'project' }],
        },
      }),
    });
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    render(<RoutingTiersPanel />);
    await screen.findByText('premium');

    await user.click(screen.getByRole('button', { name: '删除 premium' }));
    await user.click(screen.getByRole('button', { name: '保存' }));

    expect(
      await screen.findByText('被 deploy-bot 引用，无法删除'),
    ).toBeInTheDocument();
    // The refused deletion must not cost the local list any row.
    expect(screen.getByText('premium')).toBeInTheDocument();
    expect(screen.getByText('economy')).toBeInTheDocument();
  });

  it('treats plugin-scope references as hints, not blocking reasons', async () => {
    stubFetch({
      [`GET ${SERVER_URL}/config/routing-tiers`]: () => ({
        status: 200,
        body: { tiers: TIERS },
      }),
      [`PUT ${SERVER_URL}/config/routing-tiers`]: () => ({
        status: 409,
        body: {
          error:
            'cannot remove routing tier(s) still referenced by agent definitions: premium',
          references: [
            { name: 'deploy-bot', scope: 'project' },
            { name: 'builtin-helper', scope: 'plugin' },
          ],
          skipped: [{ projectPath: '/projects/gone', reason: 'ENOENT' }],
        },
      }),
    });
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    render(<RoutingTiersPanel />);
    await screen.findByText('premium');

    await user.click(screen.getByRole('button', { name: '删除 premium' }));
    await user.click(screen.getByRole('button', { name: '保存' }));

    // The blocking line names only the project-scoped definition …
    const blocking = await screen.findByText('被 deploy-bot 引用，无法删除');
    expect(blocking.textContent).not.toContain('builtin-helper');
    // … while the plugin hit is shown separately as a non-blocking hint.
    expect(screen.getByText(/插件定义 builtin-helper/)).toBeInTheDocument();
    // Projects the scan could not read are reported, never silently dropped.
    expect(screen.getByText(/\/projects\/gone/)).toBeInTheDocument();
  });

  it('picker 的模型面板按 provider 分组列出全部模型', async () => {
    stubFetch({
      [`GET ${SERVER_URL}/config/routing-tiers`]: () => ({
        status: 200,
        body: { tiers: [TIERS[0]] },
      }),
    });
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    render(<RoutingTiersPanel />);
    await screen.findByText('premium');

    await user.click(screen.getByRole('button', { name: '编辑 premium' }));
    await user.click(screen.getByRole('button', { name: /模型与推理等级/ }));
    await user.click(await screen.findByText('模型'));

    // Every provider keeps its own group header and its own model list —
    // picking a model binds its provider along with it. Options are queried
    // by button role: the trigger echoes the current model name as text.
    expect(await screen.findByText('Xiaomi')).toBeInTheDocument();
    expect(screen.getByText('Anthropic')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'MiMo-V2.5' })).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: 'MiMo-V2.5-Pro' }),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Claude X' })).toBeInTheDocument();
  });

  it('上移第二行改变草稿顺序，保存后 PUT body 顺序随之改变', async () => {
    const calls = stubFetch({
      [`GET ${SERVER_URL}/config/routing-tiers`]: () => ({
        status: 200,
        body: { tiers: TIERS },
      }),
      [`PUT ${SERVER_URL}/config/routing-tiers`]: () => ({
        status: 200,
        body: { tiers: [] },
      }),
    });
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    render(<RoutingTiersPanel />);
    await screen.findByText('premium');

    // Move the second row above the first: the draft reorders locally.
    await user.click(screen.getByRole('button', { name: '上移 economy' }));
    expect(
      Array.from(document.querySelectorAll('[data-tier-row]')).map((el) =>
        el.getAttribute('data-tier-id'),
      ),
    ).toEqual(['economy', 'premium']);

    await user.click(screen.getByRole('button', { name: '保存' }));

    // The persisted order follows the draft, not the original fetch order.
    await waitFor(() => {
      expect(calls.some((c) => c.method === 'PUT')).toBe(true);
    });
    const put = calls.find((c) => c.method === 'PUT');
    expect((put?.body as Array<{ id: string }>).map((t) => t.id)).toEqual([
      'economy',
      'premium',
    ]);
  });

  it('首行的上移与末行的下移按钮 disabled', async () => {
    stubFetch({
      [`GET ${SERVER_URL}/config/routing-tiers`]: () => ({
        status: 200,
        body: { tiers: TIERS },
      }),
    });
    render(<RoutingTiersPanel />);
    await screen.findByText('premium');

    // Edges cannot move further; interior rows stay actionable.
    expect(screen.getByRole('button', { name: '上移 premium' })).toBeDisabled();
    expect(screen.getByRole('button', { name: '下移 premium' })).toBeEnabled();
    expect(
      screen.getByRole('button', { name: '上移 economy' }),
    ).toBeEnabled();
    expect(screen.getByRole('button', { name: '下移 economy' })).toBeDisabled();
  });

  it('shows the gateway 400 message inline when a target model does not exist', async () => {
    stubFetch({
      [`GET ${SERVER_URL}/config/routing-tiers`]: () => ({
        status: 200,
        body: {
          tiers: [
            {
              id: 'premium',
              label: '最强',
              description: '复杂任务',
              target: { providerId: 'v1', modelId: 'm9' },
            },
          ],
        },
      }),
      [`PUT ${SERVER_URL}/config/routing-tiers`]: () => ({
        status: 400,
        body: {
          error:
            'routing tier "premium" targets unknown model: {"providerId":"v1","modelId":"m9"}',
        },
      }),
    });
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    render(<RoutingTiersPanel />);
    await screen.findByText('premium');

    await user.click(screen.getByRole('button', { name: '保存' }));

    // The server's 400 names the tier and target; show it so the row can be
    // fixed instead of a generic failure.
    expect(
      await screen.findByText(/routing tier "premium" targets unknown model/),
    ).toBeInTheDocument();
    expect(screen.getByText('premium')).toBeInTheDocument();
  });
});
