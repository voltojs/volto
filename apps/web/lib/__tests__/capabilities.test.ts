import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  capabilityUnavailableMessage,
  loadCapabilities,
  nativeDialogsWithdrawn,
  readCapabilities,
  resetCapabilitiesForTest,
  useCapabilitiesStore,
} from '../capabilities';

function stubInfo(body: unknown, status = 200) {
  return vi.fn(async () => new Response(JSON.stringify(body), { status }));
}

beforeEach(() => resetCapabilitiesForTest());
afterEach(() => vi.unstubAllGlobals());

describe('capabilities', () => {
  it('reads nativeDialogs from GET /gateway-info once at boot', async () => {
    const fetchMock = stubInfo({
      mode: 'remote',
      capabilities: { nativeDialogs: false, lsp: true },
    });
    vi.stubGlobal('fetch', fetchMock);

    await loadCapabilities();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toContain('/gateway-info');
    expect(useCapabilitiesStore.getState().capabilities.nativeDialogs).toBe(
      false,
    );
    expect(
      nativeDialogsWithdrawn(useCapabilitiesStore.getState().capabilities),
    ).toBe(true);

    // Once per page load, not once per subscriber or per add attempt.
    await loadCapabilities();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('keeps a native-dialog gateway on the native path', async () => {
    vi.stubGlobal(
      'fetch',
      stubInfo({ mode: 'local', capabilities: { nativeDialogs: true } }),
    );
    await loadCapabilities();
    expect(
      nativeDialogsWithdrawn(useCapabilitiesStore.getState().capabilities),
    ).toBe(false);
  });

  it('treats a missing, failed or malformed answer as UNKNOWN and never throws', async () => {
    // A gateway that predates the field.
    vi.stubGlobal('fetch', stubInfo({ mode: 'remote', capabilities: {} }));
    await loadCapabilities();
    expect(useCapabilitiesStore.getState()).toMatchObject({
      status: 'ready',
      capabilities: {},
    });
    expect(
      nativeDialogsWithdrawn(useCapabilitiesStore.getState().capabilities),
    ).toBe(false);

    resetCapabilitiesForTest();
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('nope', { status: 401 })),
    );
    await expect(loadCapabilities()).resolves.toBeUndefined();
    expect(useCapabilitiesStore.getState().status).toBe('unknown');
    // UNKNOWN still lets the boot retry later; only `ready` short-circuits.
    await loadCapabilities();

    resetCapabilitiesForTest();
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('offline');
      }),
    );
    await expect(loadCapabilities()).resolves.toBeUndefined();
    expect(useCapabilitiesStore.getState().status).toBe('unknown');
  });

  it('only an explicit boolean is a fact', () => {
    expect(
      readCapabilities({ capabilities: { nativeDialogs: false } }),
    ).toEqual({ nativeDialogs: false });
    expect(readCapabilities({ capabilities: { nativeDialogs: true } })).toEqual(
      { nativeDialogs: true },
    );
    for (const body of [
      null,
      42,
      {},
      { capabilities: null },
      { capabilities: { nativeDialogs: 'no' } },
    ]) {
      expect(readCapabilities(body)).toEqual({});
    }
  });

  describe('501 capability_unavailable', () => {
    const copy = {
      picker: 'No system dialog here — type a path.',
      reveal: 'Cannot show in the file manager.',
    };

    it('turns the raw error code into the picker sentence', () => {
      // `ApiError.message` is the body's `error` field: the code, verbatim.
      expect(
        capabilityUnavailableMessage(
          { status: 501, message: 'capability_unavailable' },
          copy,
        ),
      ).toBe(copy.picker);
    });

    it('recognises the status even when the message is something else', () => {
      // Older gateways answered 501 with their own picker text.
      expect(
        capabilityUnavailableMessage(
          { status: 501, message: 'zenity: not installed' },
          copy,
        ),
      ).toBe(copy.picker);
    });

    it('leaves every other failure alone', () => {
      expect(
        capabilityUnavailableMessage(
          { status: 409, message: 'dismiss the dialog first' },
          copy,
        ),
      ).toBeUndefined();
      expect(
        capabilityUnavailableMessage(new Error('offline'), copy),
      ).toBeUndefined();
      expect(capabilityUnavailableMessage(undefined, copy)).toBeUndefined();
      expect(capabilityUnavailableMessage(null, copy)).toBeUndefined();
    });
  });
});
