/**
 * D13 queue rebuild — `pendingSteeredMessages` folds the durable steering
 * events back into the queue that has not been delivered yet.
 *
 * This is the seed `rebuild()` / cold start hand to
 * `CreateAgentOptions.initialQueuedInputs`, so every rule here is a
 * "queued messages never lose" guarantee: build/edit/remove/deliver in
 * event order, FIFO with ids preserved, legacy id-less events ignored,
 * repeated delivery idempotent.
 */

import { describe, it, expect } from "vitest";
import { pendingSteeredMessages, pendingSteeringEntries } from "../steering-rebuild.js";
import type { TranscriptEventInput } from "../ports.js";

function queued(id: string, content: string | Array<{ type: "text"; text: string }>, time = 0): TranscriptEventInput {
  return { time, type: "steering_queued", data: { id, content } };
}

function edited(id: string, content: string, time = 0): TranscriptEventInput {
  return { time, type: "steering_edited", data: { id, content } };
}

function removed(id: string, time = 0): TranscriptEventInput {
  return { time, type: "steering_removed", data: { id } };
}

function delivered(ids: string[], time = 0): TranscriptEventInput {
  return { time, type: "steering_delivered", data: { ids } };
}

describe("pendingSteeredMessages — D13 event fold", () => {
  it("folds queued/edited/removed/delivered events in FIFO order, keeping ids", () => {
    // One of each rule, two survivors so FIFO order is observable: the
    // edited entry keeps its id and its original position, the removed and
    // the delivered entries are gone, and the never-touched entry stays
    // last.
    const pending = pendingSteeredMessages([
      queued("q1", "first"),
      queued("q2", "second"),
      queued("q3", [{ type: "text", text: "third" }]),
      queued("q4", "fourth"),
      edited("q3", "third, reworded"),
      removed("q2"),
      delivered(["q1"]),
    ]);

    expect(pending).toEqual([
      { id: "q3", role: "user", content: "third, reworded" },
      { id: "q4", role: "user", content: "fourth" },
    ]);
  });

  it("legacy events without ids are ignored without throwing", () => {
    // A pre-feature `steering_queued` has no id: it cannot be addressed by
    // the id-keyed rules, so the fold skips it and keeps building from the
    // events that do carry one.
    const legacyQueued: TranscriptEventInput = {
      time: 0,
      type: "steering_queued",
      data: { content: "legacy steer" } as unknown as { id: string; content: string },
    };
    const legacyEdited: TranscriptEventInput = {
      time: 1,
      type: "steering_edited",
      data: { content: "legacy edit" } as unknown as { id: string; content: string },
    };
    const legacyRemoved: TranscriptEventInput = {
      time: 2,
      type: "steering_removed",
      data: {} as unknown as { id: string },
    };

    const pending = pendingSteeredMessages([
      legacyQueued,
      queued("q1", "modern steer"),
      legacyEdited,
      legacyRemoved,
      delivered(["q1"]),
    ]);

    expect(pending).toEqual([]);
  });

  it("duplicate delivered ids are idempotent", () => {
    // An id named twice in one delivery, then named again by a later one,
    // and finally a delivery naming an id that was never queued: every
    // extra pass finds nothing and changes nothing.
    const pending = pendingSteeredMessages([
      queued("q1", "one"),
      queued("q2", "two"),
      delivered(["q1", "q1"]),
      delivered(["q1"]),
      delivered(["ghost"]),
    ]);

    expect(pending).toEqual([{ id: "q2", role: "user", content: "two" }]);
  });

  it("a delivered id with no queued event is a no-op", () => {
    // A file-change notice is enqueued without a steering_queued broadcast, so
    // the drain's steering_delivered names an id no queued event ever created.
    // The fold must ignore it instead of inventing an entry.
    expect(pendingSteeredMessages([delivered(["ghost"])])).toEqual([]);
    expect(pendingSteeringEntries([delivered(["ghost"])])).toEqual([]);
  });
});

describe("pendingSteeringEntries — the same fold, with queue times", () => {
  it("keeps each entry's queueing time, edits keep the original time", () => {
    expect(
      pendingSteeringEntries([
        queued("q1", "first", 100),
        queued("q2", "second", 140),
        edited("q1", "first, reworded", 160),
      ]),
    ).toEqual([
      { id: "q1", content: "first, reworded", time: 100 },
      { id: "q2", content: "second", time: 140 },
    ]);
  });

  it("delivered entries carry no time because they are gone", () => {
    expect(pendingSteeringEntries([queued("q1", "x", 10), delivered(["q1"], 20)])).toEqual([]);
  });

  it("pendingSteeredMessages is the UserMessage projection of pendingSteeringEntries", () => {
    const events = [queued("q1", "x", 10)];
    expect(pendingSteeredMessages(events)).toEqual([{ id: "q1", role: "user", content: "x" }]);
  });
});
