---
title: Why everything is injected through ports
type: concept
source:
  - packages/core/src/ports.ts
  - docs/pure-agent-core.md
generated: false
verified: 2026-11-11
---

# Why everything is injected through ports

> After reading this you will: understand why this project writes an extra layer of interfaces instead of calling `Date.now()` directly.

## One rule

The core never touches I/O. Time, randomness, IDs, files, commands, the network, storage, the model — all of them are injected objects. The core only makes decisions: it returns "what to do" as effects, and an executor outside performs them.

## What you get in return

**1. Replay.** Run the same input sequence twice and you get a byte-for-byte identical state and effect sequence. This is not a theoretical benefit: the repository's evaluation records real trajectories, replays them offline, and asserts they match exactly.

**2. Testability.** Tests need no real files, real clock or real network. Give it a fixed clock and a scripted model, and you can assert "step 3 should request approval".

**3. Portability.** The same kernel runs on Node, in the browser and on edge runtimes; the only difference is what gets injected.

**4. Explainability.** When something goes wrong you can replay the scene: what the time was, what the model returned, how the approval was decided — all of it is in the record.

## The cost

- One more layer of indirection: to read the time you call `clock.now()`, not `Date.now()`.
- More complex wiring: if a port is missing, the matching capability really does not exist (the tool drops out of the visible set).
- Easy to misuse: a sneaky `await fetch()` inside the core immediately breaks all four properties above, and the tests may not notice.

## Where determinism ends

| Deterministic | Not deterministic |
| --- | --- |
| A given input sequence → the state and effect sequence | The model's output (an external service) |
| Tool routing, permission decisions, context assembly | The real filesystem changing under your feet |
| Compaction decisions (given a budget and token counts) | Network latency, timeouts |

So replay works only because **the non-deterministic parts are recorded** and fed back in during replay. Model responses and tool results are both handled this way.

## What this means for integrators

- Every port implementation you write is replaceable; do not assume the kernel knows your implementation details.
- If you need a testable host, inject a fixed clock and a scripted model rather than mocking modules.
- Do not look for retry logic in the core — retries happen on the executor side (the runner and the adapters), because only it knows what went wrong with the I/O.

## In one sentence

**The kernel is responsible for thinking it through; the host is responsible for actually doing it.** The boundary between them is the ports.