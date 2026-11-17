import { describe, expect, it } from "vitest";

import type { GatewayProfile, ShellState } from "@shared/gateway";
import { defaultPersistedProfiles, type PersistedProfiles } from "@shared/profiles";
import {
  GatewayController,
  type ControllerEvent,
  type ProfileStoreLike,
} from "../controller";
import type { ProbeResult } from "../probe";
import type { RunningGateway } from "../supervisor";

function remote(overrides: Partial<GatewayProfile> = {}): GatewayProfile {
  return {
    id: "remote",
    label: "Remote",
    kind: "remote",
    url: "https://gw.example.com",
    managed: false,
    token: "remote-token",
    ...overrides,
  };
}

function memoryStore(initial: PersistedProfiles = defaultPersistedProfiles()): ProfileStoreLike & {
  value(): PersistedProfiles;
  saves(): number;
} {
  let current = initial;
  let saves = 0;
  return {
    load: async () => current,
    save: async (value) => {
      current = value;
      saves += 1;
    },
    value: () => current,
    saves: () => saves,
  };
}

function fakeSupervisor(): {
  starts: GatewayProfile[];
  stops: number;
  start(profile: GatewayProfile): Promise<RunningGateway>;
  stop(): Promise<void>;
} {
  const starts: GatewayProfile[] = [];
  let stops = 0;
  return {
    starts,
    get stops() {
      return stops;
    },
    start: async (profile) => {
      starts.push(profile);
      return {
        url: "http://127.0.0.1:5555",
        token: "local-token",
        degraded: false,
        pid: 4242,
        stop: async () => undefined,
      };
    },
    stop: async () => {
      stops += 1;
    },
  };
}

interface Harness {
  controller: GatewayController;
  store: ReturnType<typeof memoryStore>;
  supervisor: ReturnType<typeof fakeSupervisor>;
  events: ControllerEvent[];
}

function harness(options: {
  store?: PersistedProfiles;
  probe?: (url: string, token?: string) => Promise<ProbeResult>;
} = {}): Harness {
  const store = memoryStore(options.store ?? defaultPersistedProfiles());
  const supervisor = fakeSupervisor();
  const events: ControllerEvent[] = [];
  const controller = new GatewayController({
    store,
    supervisor,
    probe: options.probe ?? (async () => ({ ok: true, version: "0.2.1", mode: "local" })),
    platform: "darwin",
    appVersion: "9.9.9",
    idFactory: () => "generated-id",
    onEvent: (event) => events.push(event),
  });
  return { controller, store, supervisor, events };
}

function stateOf(controller: GatewayController): ShellState {
  return controller.getState();
}

describe("GatewayController", () => {
  it("starts the default managed local gateway and navigates with its token", async () => {
    const h = harness();
    await h.controller.init();

    expect(h.supervisor.starts.map((entry) => entry.id)).toEqual(["local"]);
    const state = stateOf(h.controller);
    expect(state.status.state).toBe("online");
    expect(state.status.url).toBe("http://127.0.0.1:5555");
    expect(state.status.version).toBe("0.2.1");
    expect(state.profiles[0]?.hasToken).toBe(false);

    const navigate = h.events.find((event) => event.type === "navigate");
    expect(navigate).toEqual({
      type: "navigate",
      url: "http://127.0.0.1:5555/?token=local-token",
      profileId: "local",
    });
    expect(JSON.stringify(state)).not.toContain("local-token");
  });

  it("reports an offline state and does not navigate when the probe fails", async () => {
    const h = harness({ probe: async () => ({ ok: false, error: "boom" }) });
    await h.controller.init();

    expect(stateOf(h.controller).status).toMatchObject({ state: "offline", error: "boom" });
    expect(h.events.some((event) => event.type === "navigate")).toBe(false);
  });

  it("navigates to a remote gateway with its token after switching", async () => {
    const store: PersistedProfiles = {
      profiles: [defaultPersistedProfiles().profiles[0]!, remote()],
      activeProfileId: "local",
    };
    const probeCalls: Array<{ url: string; token?: string }> = [];
    const h = harness({
      store,
      probe: async (url, token) => {
        probeCalls.push(token === undefined ? { url } : { url, token });
        return { ok: true, version: "0.3.0", mode: "remote" };
      },
    });
    await h.controller.init();
    await h.controller.switchProfile("remote");

    expect(h.supervisor.stops).toBeGreaterThan(0);
    expect(probeCalls.at(-1)).toEqual({ url: "https://gw.example.com", token: "remote-token" });
    const navigate = h.events.filter((event) => event.type === "navigate").at(-1);
    expect(navigate).toEqual({
      type: "navigate",
      url: "https://gw.example.com/?token=remote-token",
      profileId: "remote",
    });
    expect(h.store.value().activeProfileId).toBe("remote");
    expect(stateOf(h.controller).status).toMatchObject({ state: "online", mode: "remote" });
  });

  it("ignores a stale probe result that resolves after a switch", async () => {
    let resolveLocal: ((result: ProbeResult) => void) | undefined;
    const localProbe = new Promise<ProbeResult>((resolve) => {
      resolveLocal = resolve;
    });
    const store: PersistedProfiles = {
      profiles: [defaultPersistedProfiles().profiles[0]!, remote()],
      activeProfileId: "local",
    };
    let calls = 0;
    const h = harness({
      store,
      probe: async () => {
        calls += 1;
        return calls === 1 ? await localProbe : { ok: true, mode: "remote" };
      },
    });

    const init = h.controller.init();
    // Let init reach the probe before switching away.
    await new Promise((resolve) => setTimeout(resolve, 10));
    await h.controller.switchProfile("remote");
    resolveLocal?.({ ok: true, mode: "local" });
    await init;

    const state = stateOf(h.controller);
    expect(state.activeProfileId).toBe("remote");
    expect(state.status).toMatchObject({ state: "online", profileId: "remote", mode: "remote" });
    expect(h.events.filter((event) => event.type === "navigate")).toHaveLength(1);
    expect(h.events.at(-1)).toMatchObject({ type: "navigate", profileId: "remote" });
  });

  it("rejects an invalid draft without saving", async () => {
    const h = harness();
    await h.controller.init();
    const before = h.store.saves();

    const result = await h.controller.saveProfile({ label: " ", kind: "remote", url: "http://h:1" });
    expect(result).toEqual({ ok: false, error: "名称不能为空" });
    expect(h.store.saves()).toBe(before);
  });

  it("creates a profile with a generated id and keeps the active one untouched", async () => {
    const h = harness();
    await h.controller.init();

    const result = await h.controller.saveProfile({
      label: "Build box",
      kind: "remote",
      url: "https://build.example.com",
      token: "tok",
    });
    expect(result.ok).toBe(true);
    const stored = h.store.value();
    expect(stored.profiles.map((entry) => entry.id)).toEqual(["local", "generated-id"]);
    expect(stored.profiles[1]).toMatchObject({ label: "Build box", kind: "remote", token: "tok" });
    expect(stored.activeProfileId).toBe("local");
  });

  it("keeps the old token when an edit leaves it blank", async () => {
    const h = harness({
      store: {
        profiles: [defaultPersistedProfiles().profiles[0]!, remote()],
        activeProfileId: "remote",
      },
    });
    await h.controller.init();
    const result = await h.controller.saveProfile({
      id: "remote",
      label: "Renamed",
      kind: "remote",
      url: "https://gw.example.com",
    });
    expect(result.ok).toBe(true);
    expect(h.store.value().profiles[1]).toMatchObject({ label: "Renamed", token: "remote-token" });
  });

  it("reconnects when the active profile is edited", async () => {
    const h = harness();
    await h.controller.init();
    const startsBefore = h.supervisor.starts.length;

    const result = await h.controller.saveProfile({
      id: "local",
      label: "Local renamed",
      kind: "local",
      managed: true,
      url: "",
    });
    expect(result.ok).toBe(true);
    expect(h.supervisor.starts.length).toBe(startsBefore + 1);
  });

  it("refuses to remove the last profile", async () => {
    const h = harness();
    await h.controller.init();
    expect(await h.controller.removeProfile("local")).toEqual({
      ok: false,
      error: "至少保留一个网关",
    });
  });

  it("switches to the first remaining profile when the active one is removed", async () => {
    const h = harness({
      store: {
        profiles: [defaultPersistedProfiles().profiles[0]!, remote()],
        activeProfileId: "remote",
      },
    });
    await h.controller.init();
    const startsBefore = h.supervisor.starts.length;

    const result = await h.controller.removeProfile("remote");
    expect(result.ok).toBe(true);
    expect(h.store.value().activeProfileId).toBe("local");
    expect(h.supervisor.starts.length).toBe(startsBefore + 1);
  });

  it("turns a supervisor startup failure into an actionable offline state", async () => {
    const h = harness();
    h.supervisor.start = async () => {
      throw new Error("找不到本地网关：先运行 pnpm turbo run build --filter @voltojs/gateway");
    };
    await h.controller.init();

    expect(stateOf(h.controller).status).toMatchObject({
      state: "offline",
      error: "找不到本地网关：先运行 pnpm turbo run build --filter @voltojs/gateway",
    });
    expect(h.events.some((event) => event.type === "navigate")).toBe(false);
  });

  it("keeps the degraded marker in the online status", async () => {
    const h = harness();
    h.supervisor.start = async () => ({
      url: "http://127.0.0.1:5555",
      token: "tok",
      degraded: true,
      stop: async () => undefined,
    });
    await h.controller.init();
    expect(stateOf(h.controller).status).toMatchObject({ state: "online", degraded: true });
    expect(stateOf(h.controller).status.detail).toContain("SQLite");
  });

  it("stops the gateway and drops late results after dispose", async () => {
    let resolveProbe: ((result: ProbeResult) => void) | undefined;
    const h = harness({
      probe: () =>
        new Promise<ProbeResult>((resolve) => {
          resolveProbe = resolve;
        }),
    });
    const init = h.controller.init();
    await new Promise((resolve) => setTimeout(resolve, 10));
    await h.controller.dispose();
    const eventsAfterDispose = h.events.length;
    resolveProbe?.({ ok: true, mode: "local" });
    await init;

    expect(h.supervisor.stops).toBeGreaterThan(0);
    expect(h.events).toHaveLength(eventsAfterDispose);
  });
});