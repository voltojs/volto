/**
 * Routing tier CRUD panel: fetches and lists the gateway's tier table on
 * mount, edits rows as a local draft, persists via a full-table PUT, and
 * surfaces the 409 reference conflict without losing the local list.
 */

import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { RoutingTiersPanel } from '../RoutingTiersPanel';
import { useConfigStore, type Provider } from '@/stores/config-store';
import { SERVER_URL } from '@/lib/agent-config';

// jsdom does not implement the pointer-capture / scroll APIs Base UI's
// Select uses internally; stub them so the popup can open in tests.
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
      { id: 'm2', name: 'MiMo-V2.5-Pro', code: 'mimo-v2.5-pro' },
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

const TIERS = [
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
  it('渲染即拉取并列出档位（mock fetch）', async () => {
    const calls = stubFetch({
      [`GET ${SERVER_URL}/config/routing-tiers`]: () => ({
        status: 200,
        body: { tiers: TIERS },
      }),
    });
    render(<RoutingTiersPanel />);

    // Every tier is listed with its editable fields.
    expect(await screen.findByDisplayValue('premium')).toBeInTheDocument();
    expect(screen.getByDisplayValue('最强')).toBeInTheDocument();
    expect(screen.getByDisplayValue('economy')).toBeInTheDocument();
    expect(screen.getByDisplayValue('省成本')).toBeInTheDocument();
    expect(calls).toEqual([
      {
        method: 'GET',
        path: `${SERVER_URL}/config/routing-tiers`,
        body: undefined,
      },
    ]);
  });

  it('新增档位：填 id/label/description、选 provider+model → 保存发起 PUT 且 body 含新档位', async () => {
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

    await user.click(screen.getByRole('combobox', { name: 'provider' }));
    await user.click(await screen.findByRole('option', { name: 'Xiaomi' }));
    await user.click(screen.getByRole('combobox', { name: 'model' }));
    await user.click(await screen.findByRole('option', { name: 'MiMo-V2.5' }));

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
    await screen.findByDisplayValue('premium');

    await user.click(screen.getByRole('button', { name: '删除 premium' }));
    await user.click(screen.getByRole('button', { name: '保存' }));

    expect(
      await screen.findByText('被 deploy-bot 引用，无法删除'),
    ).toBeInTheDocument();
    // The refused deletion must not cost the local list any row.
    expect(screen.getByDisplayValue('premium')).toBeInTheDocument();
    expect(screen.getByDisplayValue('economy')).toBeInTheDocument();
  });

  it('target 选 provider 后 model 下拉只列该 provider 的模型', async () => {
    stubFetch({
      [`GET ${SERVER_URL}/config/routing-tiers`]: () => ({
        status: 200,
        body: { tiers: [TIERS[0]] },
      }),
    });
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    render(<RoutingTiersPanel />);
    await screen.findByDisplayValue('premium');

    await user.click(screen.getByRole('combobox', { name: 'provider' }));
    await user.click(await screen.findByRole('option', { name: 'Anthropic' }));

    await user.click(screen.getByRole('combobox', { name: 'model' }));
    const options = await screen.findAllByRole('option');
    expect(options.map((option) => option.textContent)).toEqual(['Claude X']);
    expect(screen.queryByRole('option', { name: /MiMo/ })).toBeNull();
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
    await screen.findByDisplayValue('premium');

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
    await screen.findByDisplayValue('premium');

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
    await screen.findByDisplayValue('premium');

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
    await screen.findByDisplayValue('premium');

    await user.click(screen.getByRole('button', { name: '保存' }));

    // The server's 400 names the tier and target; show it so the row can be
    // fixed instead of a generic failure.
    expect(
      await screen.findByText(/routing tier "premium" targets unknown model/),
    ).toBeInTheDocument();
    expect(screen.getByDisplayValue('premium')).toBeInTheDocument();
  });
});
