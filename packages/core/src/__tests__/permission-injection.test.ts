import { describe, it, expect } from "vitest";
import { step, createInitialState } from "../reducer.js";
import type { StepContext } from "../reducer.js";
import type { Effect } from "../effect.js";
import type { PermissionConfig } from "../permission-policy.js";
import { assembleContext } from "../context-assembler.js";

const ask: PermissionConfig = { sandbox: "workspace-write", approval: "ask" };
const auto: PermissionConfig = { sandbox: "workspace-write", approval: "never" };

function ctx(permissionConfig?: PermissionConfig): StepContext {
  return { tools: [], permissionConfig };
}

function sendUser(state: ReturnType<typeof createInitialState>, text: string, c: StepContext) {
  return step(state, { type: "user_message", content: text }, c);
}

describe("permission reminder injection", () => {
  it("injects on the first turn", () => {
    const r = sendUser(createInitialState(), "hi", ctx(ask));
    const texts = r.state.messages.map((m) => (typeof m.content === "string" ? m.content : ""));
    expect(texts.some((t) => t.includes("<system-reminder>"))).toBe(true);
  });

  it("puts the reminder BEFORE the user message", () => {
    const r = sendUser(createInitialState(), "hi", ctx(ask));
    const idxReminder = r.state.messages.findIndex(
      (m) => typeof m.content === "string" && m.content.includes("<system-reminder>"),
    );
    const idxUser = r.state.messages.findIndex(
      (m) => typeof m.content === "string" && m.content === "hi",
    );
    expect(idxReminder).toBeGreaterThanOrEqual(0);
    expect(idxReminder).toBeLessThan(idxUser);
  });

  it("injects as a user-role message, not a system message", () => {
    const r = sendUser(createInitialState(), "hi", ctx(ask));
    const reminder = r.state.messages.find(
      (m) => typeof m.content === "string" && m.content.includes("<system-reminder>"),
    );
    expect(reminder?.role).toBe("user");
  });

  it("does NOT inject again while the config is unchanged", () => {
    const first = sendUser(createInitialState(), "one", ctx(ask));
    const ready = { ...first.state, status: "idle" as const };
    const second = sendUser(ready, "two", ctx(ask));
    const count = second.state.messages.filter(
      (m) => typeof m.content === "string" && m.content.includes("<system-reminder>"),
    ).length;
    expect(count).toBe(1);
  });

  it("injects again when the config changes, framed as a change", () => {
    const first = sendUser(createInitialState(), "one", ctx(ask));
    const ready = { ...first.state, status: "idle" as const };
    const second = sendUser(ready, "two", ctx(auto));
    const reminders = second.state.messages.filter(
      (m) => typeof m.content === "string" && m.content.includes("<system-reminder>"),
    );
    expect(reminders).toHaveLength(2);
    expect(String(reminders[1]!.content)).toMatch(/changed/i);
  });

  it("injects nothing when no permissionConfig is supplied", () => {
    const r = sendUser(createInitialState(), "hi", ctx(undefined));
    const any = r.state.messages.some(
      (m) => typeof m.content === "string" && m.content.includes("<system-reminder>"),
    );
    expect(any).toBe(false);
  });
});

describe("prompt cache prefix stability", () => {
  const systemMsg = { role: "system" as const, content: "You are a helpful agent." };

  it("keeps the static prefix byte-identical across an unchanged turn", () => {
    const base = { ...createInitialState(), messages: [systemMsg] };
    const first = sendUser(base, "one", ctx(ask));
    const ready = { ...first.state, status: "idle" as const };
    const second = sendUser(ready, "two", ctx(ask));

    const a = assembleContext({ messages: first.state.messages, tools: [] });
    const b = assembleContext({ messages: second.state.messages, tools: [] });
    expect(b.staticPrefixLength).toBe(a.staticPrefixLength);
    expect(b.messages.slice(0, a.staticPrefixLength)).toEqual(
      a.messages.slice(0, a.staticPrefixLength),
    );
  });

  it("keeps the static prefix byte-identical even when the boundary CHANGES", () => {
    const base = { ...createInitialState(), messages: [systemMsg] };
    const first = sendUser(base, "one", ctx(ask));
    const ready = { ...first.state, status: "idle" as const };
    const second = sendUser(ready, "two", ctx(auto));

    const a = assembleContext({ messages: first.state.messages, tools: [] });
    const b = assembleContext({ messages: second.state.messages, tools: [] });
    expect(b.staticPrefixLength).toBe(a.staticPrefixLength);
    expect(b.messages.slice(0, a.staticPrefixLength)).toEqual(
      a.messages.slice(0, a.staticPrefixLength),
    );
  });

  it("appends the change only at the tail", () => {
    const base = { ...createInitialState(), messages: [systemMsg] };
    const first = sendUser(base, "one", ctx(ask));
    const ready = { ...first.state, status: "idle" as const };
    const second = sendUser(ready, "two", ctx(auto));

    expect(second.state.messages.slice(0, first.state.messages.length)).toEqual(
      first.state.messages,
    );
  });
});

describe("permission reminder audit event", () => {
  it("emits a context_reminder alongside the injected message", () => {
    const r = sendUser(createInitialState(), "hi", ctx(ask));
    const reminderText = r.state.messages.find(
      (m) => typeof m.content === "string" && m.content.includes("<system-reminder>"),
    )!.content as string;

    const evt = r.effects.find(
      (e): e is Extract<Effect, { type: "emit" }> =>
        e.type === "emit" && e.event.type === "context_reminder",
    );
    expect(evt).toBeDefined();
    expect(evt!.event.data.kind).toBe("permission_boundary");
    expect(evt!.event.data.text).toBe(reminderText);
  });

  it("does not emit again while the config is unchanged", () => {
    const first = sendUser(createInitialState(), "one", ctx(ask));
    const ready = { ...first.state, status: "idle" as const };
    const second = sendUser(ready, "two", ctx(ask));
    const count = second.effects.filter(
      (e): e is Extract<Effect, { type: "emit" }> =>
        e.type === "emit" && e.event.type === "context_reminder",
    ).length;
    expect(count).toBe(0);
  });
});
