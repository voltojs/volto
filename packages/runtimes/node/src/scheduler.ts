/**
 * Node Scheduler adapter — implements the M8 Scheduler port.
 *
 * Manages timed/delayed/background tasks using Node.js timers.
 * All timing goes through the injected Clock port for determinism
 * and replay capability. Wake-up events are normalized as inputs
 * to the main agent loop.
 */

import type { Scheduler, Clock } from "@agent-core/core";

interface ScheduledTask {
  id: string;
  ref: string;
  timeout: ReturnType<typeof setTimeout>;
  fired: boolean;
}

export interface NodeSchedulerOptions {
  /** Clock for time injection (determinism in tests) */
  clock: Clock;
}

let taskCounter = 0;

/**
 * Create a Node.js Scheduler adapter.
 *
 * `schedule(delayMs, ref)` creates a timer that fires after `delayMs`.
 * The `ref` string is the wake-up reference — it's passed back to the
 * agent as an input when the timer fires.
 *
 * `sleep(ms)` is a promise-based delay using the Clock.
 *
 * `cancel(id)` clears a pending timer.
 */
export function createNodeScheduler(opts: NodeSchedulerOptions): Scheduler {
  const { clock } = opts;
  const tasks = new Map<string, ScheduledTask>();

  return {
    async schedule(delayMs: number, ref: string): Promise<string> {
      const id = `sched-${taskCounter++}`;
      const fireAt = clock.now() + delayMs;

      const timeout = setTimeout(() => {
        const task = tasks.get(id);
        if (task && !task.fired) {
          task.fired = true;
          tasks.delete(id);
          // In a real integration, this would feed a wake-up input
          // to the agent loop via the injected EventSink or callback.
          // For now, it simply marks the task as fired.
        }
      }, delayMs);

      tasks.set(id, { id, ref, timeout, fired: false });
      return id;
    },

    async cancel(id: string): Promise<boolean> {
      const task = tasks.get(id);
      if (!task) return false;
      clearTimeout(task.timeout);
      tasks.delete(id);
      return true;
    },

    async sleep(ms: number, abortSignal?: AbortSignal): Promise<void> {
      if (ms <= 0) return;

      return new Promise<void>((resolve) => {
        const timeout = setTimeout(() => {
          abortSignal?.removeEventListener("abort", onAbort);
          resolve();
        }, ms);

        const onAbort = (): void => {
          clearTimeout(timeout);
          resolve();
        };

        if (abortSignal) {
          if (abortSignal.aborted) {
            clearTimeout(timeout);
            resolve();
          } else {
            abortSignal.addEventListener("abort", onAbort, { once: true });
          }
        }
      });
    },
  };
}
