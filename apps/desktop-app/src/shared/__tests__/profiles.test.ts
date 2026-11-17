import { describe, expect, it } from "vitest";

import { buildGatewayEntryUrl, type GatewayProfile, type GatewayStatus } from "../gateway";
import {
  DEFAULT_PROFILE_ID,
  defaultPersistedProfiles,
  normalizeGatewayUrl,
  normalizeProfileDraft,
  removeProfile,
  sanitizePersistedProfiles,
  toPublicState,
  upsertProfile,
} from "../profiles";

function profile(overrides: Partial<GatewayProfile>): GatewayProfile {
  return {
    id: "p1",
    label: "Gateway",
    kind: "remote",
    url: "https://gw.example.com",
    managed: false,
    ...overrides,
  };
}

describe("normalizeGatewayUrl", () => {
  it("adds http:// when the scheme is missing", () => {
    expect(normalizeGatewayUrl("localhost:3100")).toEqual({ ok: true, url: "http://localhost:3100" });
  });

  it("strips a trailing slash and keeps the origin only", () => {
    expect(normalizeGatewayUrl("https://gw.example.com/")).toEqual({
      ok: true,
      url: "https://gw.example.com",
    });
  });

  it("keeps a non-default port", () => {
    expect(normalizeGatewayUrl("http://127.0.0.1:3100")).toEqual({
      ok: true,
      url: "http://127.0.0.1:3100",
    });
  });

  it.each([
    ["", "网关地址不能为空"],
    ["file:///tmp/x", "网关地址只支持 http:// 或 https://"],
    ["ftp://host", "网关地址只支持 http:// 或 https://"],
    ["http://user:pass@host", "网关地址不能包含用户名或密码"],
    ["http://host/api", "网关地址只填到端口，不要带路径"],
    ["http://host?x=1", "网关地址不能带查询参数或锚点"],
    ["http://host#frag", "网关地址不能带查询参数或锚点"],
  ])("rejects %j", (raw, error) => {
    expect(normalizeGatewayUrl(raw)).toEqual({ ok: false, error });
  });
});

describe("normalizeProfileDraft", () => {
  it("rejects a blank label", () => {
    const result = normalizeProfileDraft({ label: "   ", kind: "remote", url: "http://h:1" });
    expect(result).toEqual({ ok: false, error: "名称不能为空" });
  });

  it("rejects a label longer than 60 characters", () => {
    const result = normalizeProfileDraft({ label: "x".repeat(61), kind: "remote", url: "http://h:1" });
    expect(result).toEqual({ ok: false, error: "名称不能超过 60 个字符" });
  });

  it("requires a url for a remote gateway", () => {
    expect(normalizeProfileDraft({ label: "Remote", kind: "remote" })).toEqual({
      ok: false,
      error: "网关地址不能为空",
    });
  });

  it("forces managed to false for a remote gateway", () => {
    expect(
      normalizeProfileDraft({ label: " Remote ", kind: "remote", url: "https://gw.example.com/", managed: true }),
    ).toEqual({
      ok: true,
      value: { label: "Remote", kind: "remote", url: "https://gw.example.com", managed: false },
    });
  });

  it("allows a managed local gateway without a url", () => {
    expect(normalizeProfileDraft({ label: "Local", kind: "local" })).toEqual({
      ok: true,
      value: { label: "Local", kind: "local", url: "", managed: true },
    });
  });

  it("requires a url for an unmanaged local gateway", () => {
    expect(normalizeProfileDraft({ label: "Local", kind: "local", managed: false })).toEqual({
      ok: false,
      error: "直连本机网关需要填写地址",
    });
  });

  it("trims the token and drops an empty one", () => {
    expect(
      normalizeProfileDraft({ label: "Remote", kind: "remote", url: "http://h:1", token: "  tok  " }),
    ).toEqual({
      ok: true,
      value: { label: "Remote", kind: "remote", url: "http://h:1", managed: false, token: "tok" },
    });
    expect(normalizeProfileDraft({ label: "Remote", kind: "remote", url: "http://h:1", token: "  " })).toEqual({
      ok: true,
      value: { label: "Remote", kind: "remote", url: "http://h:1", managed: false },
    });
  });
});

describe("upsertProfile", () => {
  it("appends a new profile", () => {
    const next = upsertProfile([profile({ id: "a" })], profile({ id: "b" }));
    expect(next.map((entry) => entry.id)).toEqual(["a", "b"]);
  });

  it("replaces an existing profile in place", () => {
    const next = upsertProfile([profile({ id: "a", label: "old" })], profile({ id: "a", label: "new" }));
    expect(next).toHaveLength(1);
    expect(next[0]?.label).toBe("new");
  });

  it("does not mutate the input array", () => {
    const input = [profile({ id: "a" })];
    upsertProfile(input, profile({ id: "b" }));
    expect(input).toHaveLength(1);
  });
});

describe("removeProfile", () => {
  it("refuses to remove the last profile", () => {
    expect(removeProfile([profile({ id: "a" })], "a", "a")).toEqual({
      ok: false,
      error: "至少保留一个网关",
    });
  });

  it("refuses an unknown id", () => {
    expect(removeProfile([profile({ id: "a" }), profile({ id: "b" })], "zzz", "a")).toEqual({
      ok: false,
      error: "网关不存在",
    });
  });

  it("moves the active profile to the first remaining one", () => {
    const result = removeProfile([profile({ id: "a" }), profile({ id: "b" })], "a", "a");
    expect(result).toEqual({
      ok: true,
      profiles: [profile({ id: "b" })],
      activeProfileId: "b",
    });
  });

  it("keeps the active profile when a different one is removed", () => {
    const result = removeProfile([profile({ id: "a" }), profile({ id: "b" })], "b", "a");
    expect(result).toEqual({ ok: true, profiles: [profile({ id: "a" })], activeProfileId: "a" });
  });
});

describe("defaultPersistedProfiles", () => {
  it("starts with one managed local gateway", () => {
    expect(defaultPersistedProfiles()).toEqual({
      profiles: [
        { id: DEFAULT_PROFILE_ID, label: "本机网关", kind: "local", url: "", managed: true },
      ],
      activeProfileId: DEFAULT_PROFILE_ID,
    });
  });
});

describe("sanitizePersistedProfiles", () => {
  const fallback = defaultPersistedProfiles();

  it("falls back when the value is not an object", () => {
    expect(sanitizePersistedProfiles(null, fallback)).toBe(fallback);
    expect(sanitizePersistedProfiles("nope", fallback)).toBe(fallback);
  });

  it("falls back when no entry is usable", () => {
    expect(sanitizePersistedProfiles({ profiles: [{ bogus: true }], activeProfileId: "x" }, fallback)).toBe(
      fallback,
    );
  });

  it("drops invalid entries and keeps valid ones", () => {
    const raw = {
      profiles: [
        { id: "a", label: "A", kind: "local", url: "", managed: true },
        { id: "", label: "B", kind: "local", url: "", managed: true },
        { id: "c", label: "C", kind: "remote", url: "", managed: false },
        { id: "d", label: "D", kind: "local", url: "", managed: false },
      ],
      activeProfileId: "a",
    };
    expect(sanitizePersistedProfiles(raw, fallback)).toEqual({
      profiles: [{ id: "a", label: "A", kind: "local", url: "", managed: true }],
      activeProfileId: "a",
    });
  });

  it("drops an entry whose url is not an http origin", () => {
    const raw = {
      profiles: [
        { id: "a", label: "A", kind: "remote", url: "file:///etc/passwd", managed: false },
        { id: "b", label: "B", kind: "remote", url: "not a url", managed: false },
        { id: "c", label: "C", kind: "local", url: "", managed: true },
      ],
      activeProfileId: "a",
    };
    expect(sanitizePersistedProfiles(raw, fallback)).toEqual({
      profiles: [{ id: "c", label: "C", kind: "local", url: "", managed: true }],
      activeProfileId: "c",
    });
  });

  it("drops duplicate ids", () => {
    const raw = {
      profiles: [
        { id: "a", label: "A", kind: "local", url: "", managed: true },
        { id: "a", label: "A2", kind: "local", url: "", managed: true },
      ],
    };
    expect(sanitizePersistedProfiles(raw, fallback).profiles).toHaveLength(1);
  });

  it("falls back to the first profile when the active id is unknown", () => {
    const raw = {
      profiles: [{ id: "a", label: "A", kind: "local", url: "", managed: true }],
      activeProfileId: "missing",
    };
    expect(sanitizePersistedProfiles(raw, fallback).activeProfileId).toBe("a");
  });

  it("keeps a token and normalizes remote managed to false", () => {
    const raw = {
      profiles: [
        {
          id: "r",
          label: "R",
          kind: "remote",
          url: "https://gw.example.com",
          managed: true,
          token: "  secret  ",
        },
      ],
      activeProfileId: "r",
    };
    expect(sanitizePersistedProfiles(raw, fallback)).toEqual({
      profiles: [
        {
          id: "r",
          label: "R",
          kind: "remote",
          url: "https://gw.example.com",
          managed: false,
          token: "secret",
        },
      ],
      activeProfileId: "r",
    });
  });
});

describe("toPublicState", () => {
  it("removes tokens and reports their presence", () => {
    const status: GatewayStatus = { state: "online", profileId: "r", url: "https://gw" };
    const state = toPublicState({
      profiles: [profile({ id: "r", token: "secret" }), profile({ id: "l", kind: "local", token: undefined })],
      activeProfileId: "r",
      status,
      sheetOpen: true,
      platform: "darwin",
      appVersion: "0.0.1",
    });
    expect(state.profiles[0]).toEqual({
      id: "r",
      label: "Gateway",
      kind: "remote",
      url: "https://gw.example.com",
      managed: false,
      hasToken: true,
    });
    expect(state.profiles[0]).not.toHaveProperty("token");
    expect(state.profiles[1]?.hasToken).toBe(false);
    expect(JSON.stringify(state)).not.toContain("secret");
    expect(state.sheetOpen).toBe(true);
  });
});

describe("buildGatewayEntryUrl", () => {
  it("adds the token as a query parameter", () => {
    expect(buildGatewayEntryUrl("http://127.0.0.1:3100", "a b")).toBe(
      "http://127.0.0.1:3100/?token=a+b",
    );
  });

  it("leaves the bare origin when there is no token", () => {
    expect(buildGatewayEntryUrl("https://gw.example.com")).toBe("https://gw.example.com/");
  });
});