// @vitest-environment jsdom
/**
 * The "add project" flow under both capability answers.
 *
 * Remote mode (`--serve-remote`) withdraws the native directory dialog, and
 * the dialog would open on the GATEWAY's screen anyway. When the boot
 * `/gateway-info` says so, the flow must collect a typed path instead of
 * calling the picker; when it does not say so, the picker is what a user
 * expects. And a `501 capability_unavailable` that still arrives (a gateway
 * that changed posture after boot) must read as a sentence, not as the raw
 * code.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import { useAddProject } from '@/hooks/use-add-project';
import {
  useCapabilitiesStore,
  resetCapabilitiesForTest,
} from '@/lib/capabilities';

const pickDirectory = vi.fn();
const createProject = vi.fn();
const toastError = vi.fn();
const toastSuccess = vi.fn();

vi.mock('@/lib/config-api', async () => {
  const actual =
    await vi.importActual<typeof import('@/lib/config-api')>(
      '@/lib/config-api',
    );
  return {
    ...actual,
    pickDirectory: (...args: unknown[]) => pickDirectory(...args),
    createProject: (...args: unknown[]) => createProject(...args),
  };
});

vi.mock('sonner', () => ({
  toast: {
    error: (...args: unknown[]) => toastError(...args),
    success: (...args: unknown[]) => toastSuccess(...args),
  },
}));

/** `ApiError` from the real module: the hook classifies an instance of it. */
async function apiError(status: number, message: string): Promise<Error> {
  const { ApiError } = await import('@/lib/config-api');
  return new ApiError(message, status);
}

beforeEach(() => {
  // The config store's `addProject` is the real one; it calls the mocked
  // `createProject`. Dialogs available unless a case says otherwise.
  useCapabilitiesStore.setState({
    status: 'ready',
    capabilities: { nativeDialogs: true },
  });
  pickDirectory.mockReset();
  createProject.mockReset();
  toastError.mockReset();
  toastSuccess.mockReset();
});

afterEach(() => resetCapabilitiesForTest());

describe('useAddProject', () => {
  it('opens the native picker when the gateway can show dialogs', async () => {
    pickDirectory.mockResolvedValue({ path: '/home/me/repo' });
    createProject.mockResolvedValue({
      id: 'p1',
      name: 'repo',
      path: '/home/me/repo',
      createdAt: 0,
    });

    const { result } = renderHook(() => useAddProject());
    const project = await act(async () => result.current.run());

    expect(pickDirectory).toHaveBeenCalledTimes(1);
    expect(project).toMatchObject({ id: 'p1' });
    expect(result.current.manual).toBe(false);
  });

  it('asks for a typed path instead of the picker when nativeDialogs is false', async () => {
    useCapabilitiesStore.setState({
      status: 'ready',
      capabilities: { nativeDialogs: false },
    });

    const { result } = renderHook(() => useAddProject());
    const project = await act(async () => result.current.run());

    // The picker is never called: there is no dialog to open on this deployment.
    expect(pickDirectory).not.toHaveBeenCalled();
    expect(project).toBeNull();
    expect(result.current.manual).toBe(true);
  });

  it('creates the workspace from the typed path and closes the fallback', async () => {
    useCapabilitiesStore.setState({
      status: 'ready',
      capabilities: { nativeDialogs: false },
    });
    createProject.mockResolvedValue({
      id: 'p2',
      name: 'myrepo',
      path: ' /srv/myrepo ',
      createdAt: 0,
    });

    const { result } = renderHook(() => useAddProject());
    await act(async () => result.current.run());
    const project = await act(async () =>
      result.current.addByPath(' /srv/myrepo '),
    );

    expect(createProject).toHaveBeenCalledWith({
      name: 'myrepo',
      path: '/srv/myrepo',
    });
    expect(project).toMatchObject({ id: 'p2' });
    expect(result.current.manual).toBe(false);
    expect(toastSuccess).toHaveBeenCalled();
  });

  it('an empty typed path is not a choice and creates nothing', async () => {
    useCapabilitiesStore.setState({
      status: 'ready',
      capabilities: { nativeDialogs: false },
    });
    const { result } = renderHook(() => useAddProject());
    await act(async () => result.current.run());

    const project = await act(async () => result.current.addByPath('   '));

    expect(project).toBeNull();
    expect(createProject).not.toHaveBeenCalled();
  });

  it('surfaces a 501 capability_unavailable as a readable message, then falls back to the typed path', async () => {
    // Boot said "dialogs are available" (or the gateway changed after boot):
    // the request is the first thing to learn otherwise.
    pickDirectory.mockRejectedValue(
      await apiError(501, 'capability_unavailable'),
    );

    const { result } = renderHook(() => useAddProject());
    const project = await act(async () => result.current.run());

    expect(project).toBeNull();
    // The zh catalog's copy, not the raw code.
    expect(toastError).toHaveBeenCalledTimes(1);
    const shown = String(toastError.mock.calls[0]?.[0]);
    expect(shown).not.toContain('capability_unavailable');
    expect(shown).toContain('远程模式');
    // ...and the flow moves to the input that CAN work.
    expect(result.current.manual).toBe(true);
  });

  it('keeps a busy dialog a distinct, actionable failure', async () => {
    pickDirectory.mockRejectedValue(
      await apiError(409, 'A directory dialog is already open'),
    );

    const { result } = renderHook(() => useAddProject());
    await act(async () => result.current.run());

    expect(String(toastError.mock.calls[0]?.[0])).toContain(
      '系统目录对话框已打开',
    );
    expect(result.current.manual).toBe(false);
  });

  it('a cancelled dialog is silent', async () => {
    pickDirectory.mockResolvedValue({ path: null });

    const { result } = renderHook(() => useAddProject());
    const project = await act(async () => result.current.run());

    expect(project).toBeNull();
    expect(toastError).not.toHaveBeenCalled();
    expect(toastSuccess).not.toHaveBeenCalled();
    expect(createProject).not.toHaveBeenCalled();
  });

  it('waits for the boot capability answer before choosing a path', async () => {
    // Before `/gateway-info` lands, the flow is the one every earlier gateway
    // had: the picker. A missing answer must not switch the UI to "remote".
    resetCapabilitiesForTest();
    pickDirectory.mockResolvedValue({ path: null });

    const { result } = renderHook(() => useAddProject());
    await act(async () => result.current.run());

    expect(pickDirectory).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(result.current.manual).toBe(false));
  });
});
