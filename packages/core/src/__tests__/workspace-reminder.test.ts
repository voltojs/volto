import { describe, it, expect } from "vitest";
import { step, createInitialState } from "../reducer.js";
import type { StepContext } from "../reducer.js";

const CWD_A = "Working directory: /repo (project: volto)\nGit branch: main";
const CWD_B = "Working directory: /repo-wt (project: volto)\nGit branch: feat/x";

function ctx(reminder?: { key: string; announce: string }): StepContext {
  return { tools: [], ...(reminder !== undefined ? { workspaceReminder: reminder } : {}) };
}

function sendUser(
  state: ReturnType<typeof createInitialState>,
  text: string,
  c: StepContext,
) {
  return step(state, { type: "user_message", content: text }, c);
}

function reminderTexts(messages: readonly { role: string; content: unknown }[]): string[] {
  return messages
    .filter(
      (m) =>
        m.role === "user" &&
        typeof m.content === "string" &&
        m.content.includes("<system-reminder>") &&
        m.content.includes("Working directory:"),
    )
    .map((m) => String(m.content));
}

describe("workspace reminder injection", () => {
  it("injects the first announcement as a tail user reminder before the user message", () => {
    const r = sendUser(createInitialState(), "what branch are we on?", ctx({ key: "a", announce: CWD_A }));

    const idxReminder = r.state.messages.findIndex(
      (m) => typeof m.content === "string" && m.content.includes(CWD_A),
    );
    const idxUser = r.state.messages.findIndex(
      (m) => m.role === "user" && m.content === "what branch are we on?",
    );
    expect(idxReminder).toBeGreaterThanOrEqual(0);
    expect(idxReminder).toBeLessThan(idxUser);
    expect(r.state.messages[idxReminder]!.role).toBe("user");
    expect(String(r.state.messages[idxReminder]!.content)).toBe(
      `<system-reminder>\n${CWD_A}\n</system-reminder>`,
    );
    expect(r.state._announcedWorkspace).toBe("a");
  });

  it("emits a context_reminder event with kind workspace", () => {
    const r = sendUser(createInitialState(), "hi", ctx({ key: "a", announce: CWD_A }));
    expect(r.effects).toContainEqual(
      expect.objectContaining({
        type: "emit",
        event: expect.objectContaining({
          type: "context_reminder",
          data: expect.objectContaining({ kind: "workspace", text: CWD_A }),
        }),
      }),
    );
  });

  it("stays silent while the fingerprint is unchanged", () => {
    // Seeded state = a live session that already announced key "a"; a new
    // turn inside it must not repeat the message. (`step` queues a second
    // user_message into the steering path while status is calling_model, so
    // driving two turns through messages would test the queue, not the
    // fingerprint.)
    const seeded = createInitialState({ _announcedWorkspace: "a" });
    const r = sendUser(seeded, "two", ctx({ key: "a", announce: CWD_A }));

    expect(reminderTexts(r.state.messages)).toHaveLength(0);
    expect(
      r.effects.some(
        (e) => e.type === "emit" && e.event.type === "context_reminder",
      ),
    ).toBe(false);
  });

  it("re-injects with the new text when the fingerprint changes", () => {
    const seeded = createInitialState({ _announcedWorkspace: "a" });
    const r = sendUser(seeded, "two", ctx({ key: "b", announce: CWD_B }));

    const texts = reminderTexts(r.state.messages);
    expect(texts).toHaveLength(1);
    expect(texts[0]).toContain(CWD_B);
    expect(r.state._announcedWorkspace).toBe("b");
  });

  it("does not inject at all when the channel is absent", () => {
    const r = sendUser(createInitialState(), "hi", ctx());
    expect(reminderTexts(r.state.messages)).toHaveLength(0);
    expect(r.state._announcedWorkspace).toBeUndefined();
  });

  it("honours a seeded fingerprint so a resumed session does not repeat itself", () => {
    const seeded = createInitialState({ _announcedWorkspace: "a" });
    const r = sendUser(seeded, "continue", ctx({ key: "a", announce: CWD_A }));
    expect(reminderTexts(r.state.messages)).toHaveLength(0);
  });
});