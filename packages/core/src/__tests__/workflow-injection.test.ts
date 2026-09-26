import { describe, it, expect } from "vitest";
import { step, createInitialState } from "../reducer.js";
import type { StepContext } from "../reducer.js";
import type { Effect } from "../effect.js";

const ENTER = "You are in plan mode (plan). workflow text";
const EXIT = "Plan mode has ended. exit text";

function ctx(key?: string, announce: string = key === "plan" ? ENTER : EXIT): StepContext {
  return { tools: [], workflowReminder: { key, announce } };
}

function sendUser(state: ReturnType<typeof createInitialState>, text: string, c: StepContext) {
  return step(state, { type: "user_message", content: text }, c);
}

function reminderTexts(messages: readonly { role: string; content: unknown }[]): string[] {
  return messages
    .filter((m) => m.role === "user" && typeof m.content === "string" && m.content.includes("<system-reminder>"))
    .map((m) => String(m.content));
}

describe("workflow-mode reminder injection", () => {
  it("injects the enter text as a tail user reminder BEFORE the user message", () => {
    const r = sendUser(createInitialState(), "make a plan", ctx("plan"));
    const idxReminder = r.state.messages.findIndex(
      (m) => typeof m.content === "string" && m.content.includes(ENTER),
    );
    const idxUser = r.state.messages.findIndex(
      (m) => typeof m.role === "string" && m.role === "user" && m.content === "make a plan",
    );
    expect(idxReminder).toBeGreaterThanOrEqual(0);
    expect(idxReminder).toBeLessThan(idxUser);
    expect(r.state.messages[idxReminder]!.role).toBe("user");
    expect(String(r.state.messages[idxReminder]!.content)).toContain("<system-reminder>");
    expect(r.state._announcedWorkflowMode).toBe("plan");
  });

  it("emits a context_reminder event with kind workflow_mode", () => {
    const r = sendUser(createInitialState(), "hi", ctx("plan"));
    expect(r.effects).toContainEqual(
      expect.objectContaining({
        type: "emit",
        event: expect.objectContaining({
          type: "context_reminder",
          data: expect.objectContaining({ kind: "workflow_mode", text: ENTER }),
        }),
      }),
    );
  });

  it("EXIT PAIR A: seeded fingerprint + base key injects the exit text (spec §9-2)", () => {
    const seeded = createInitialState({ _announcedWorkflowMode: "plan" });
    const r = sendUser(seeded, "go ahead", ctx(undefined));
    const texts = reminderTexts(r.state.messages);
    expect(texts.some((t) => t.includes(EXIT))).toBe(true);
    expect(r.state._announcedWorkflowMode).toBeUndefined();
  });

  it("EXIT PAIR B: no seed + base key injects nothing (clean start makes no noise)", () => {
    const r = sendUser(createInitialState(), "hello", ctx(undefined));
    expect(reminderTexts(r.state.messages)).toHaveLength(0);
    expect(r.state._announcedWorkflowMode).toBeUndefined();
  });

  it("does not inject again while the key is unchanged", () => {
    const first = sendUser(createInitialState(), "one", ctx("plan"));
    const ready = { ...first.state, status: "idle" as const };
    const second = sendUser(ready, "two", ctx("plan"));
    expect(reminderTexts(second.state.messages).filter((t) => t.includes(ENTER))).toHaveLength(1);
    // §9-3's other half: unchanged key emits no context_reminder event either.
    expect(second.effects).not.toContainEqual(
      expect.objectContaining({
        type: "emit",
        event: expect.objectContaining({ type: "context_reminder" }),
      }),
    );
  });

  it("SEED SUPPRESSION: same key on a seeded instance injects nothing (spec §9-6)", () => {
    const seeded = createInitialState({ _announcedWorkflowMode: "plan" });
    const r = sendUser(seeded, "still planning", ctx("plan"));
    expect(reminderTexts(r.state.messages)).toHaveLength(0);
  });

  it("cold restart re-announces the current state (state-descriptive)", () => {
    // Fresh state (no seed) + key "plan" — the cold-resume path. The text
    // is whatever the host supplied; hosts must supply state-descriptive
    // wording (spec D4) because this path exists.
    const r = sendUser(createInitialState(), "resume", ctx("plan"));
    expect(reminderTexts(r.state.messages).some((t) => t.includes(ENTER))).toBe(true);
  });

  it("injects nothing when ctx.workflowReminder is absent", () => {
    const r = sendUser(createInitialState(), "hi", { tools: [] });
    expect(reminderTexts(r.state.messages)).toHaveLength(0);
    expect(r.state._announcedWorkflowMode).toBeUndefined();
  });

  it("replay: identical (state, effects) for identical input sequences", () => {
    function run(): { messages: unknown; effects: Effect[] } {
      let state = createInitialState({ _announcedWorkflowMode: "plan" });
      const effects: Effect[] = [];
      const r1 = step(state, { type: "user_message", content: "a" }, ctx(undefined));
      state = r1.state;
      effects.push(...r1.effects);
      const r2 = step(
        { ...state, status: "idle" as const },
        { type: "user_message", content: "b" },
        ctx("plan"),
      );
      return { messages: r2.state.messages, effects: [...effects, ...r2.effects] };
    }
    expect(run()).toEqual(run());
  });
});
