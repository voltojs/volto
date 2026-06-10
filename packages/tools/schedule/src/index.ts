/**
 * @agent-core/tools-schedule — scheduling tools for timed/delayed/background tasks.
 *
 * Provides `createScheduleTool` and `createCancelScheduleTool` which
 * consume the M8 Scheduler port for timed operations.
 */

import type { Scheduler } from "@agent-core/core";
import { z } from "zod";
import { defineTool } from "@agent-core/tools-common";
import type { Tool } from "@agent-core/tools-common";

const CAP_SCHEDULER = "scheduler:exec";

const scheduleSchema = z.object({
  delay_ms: z.number().int().min(100).max(86_400_000).describe(
    "Delay in milliseconds before the task fires (max 24h = 86400000ms).",
  ),
  ref: z.string().max(500).describe(
    "A string reference that will be returned when the task fires. Use this to identify the wake-up.",
  ),
});

const cancelSchema = z.object({
  task_id: z.string().describe("The task ID returned by schedule_task."),
});

/**
 * Create a schedule tool that creates timed/delayed tasks.
 */
export function createScheduleTool(scheduler: Scheduler): Tool {
  return defineTool({
    name: "schedule_task",
    description:
      "Schedule a delayed task. After the specified delay, a wake-up event with the given ref " +
      "will be fired. Returns a task_id that can be used with cancel_task.",
    schema: scheduleSchema,
    requires: [CAP_SCHEDULER],
    riskTier: "WRITE_LOW",
    run: async ({ delay_ms, ref }) => {
      try {
        const taskId = await scheduler.schedule(delay_ms, ref);
        return {
          modelContent: `Task scheduled: id="${taskId}", ref="${ref}", delay=${delay_ms}ms`,
          displayMetadata: { taskId, ref, delayMs: delay_ms },
        };
      } catch (err) {
        return {
          modelContent: `Failed to schedule task: ${err instanceof Error ? err.message : String(err)}`,
          isError: true,
        };
      }
    },
  });
}

/**
 * Create a cancel tool that cancels a pending scheduled task.
 */
export function createCancelScheduleTool(scheduler: Scheduler): Tool {
  return defineTool({
    name: "cancel_task",
    description: "Cancel a previously scheduled task by its task_id.",
    schema: cancelSchema,
    requires: [CAP_SCHEDULER],
    riskTier: "READ_ONLY",
    run: async ({ task_id }) => {
      try {
        const cancelled = await scheduler.cancel(task_id);
        return {
          modelContent: cancelled
            ? `Task "${task_id}" cancelled successfully.`
            : `Task "${task_id}" not found (may have already fired).`,
          displayMetadata: { taskId: task_id, cancelled },
        };
      } catch (err) {
        return {
          modelContent: `Failed to cancel task: ${err instanceof Error ? err.message : String(err)}`,
          isError: true,
        };
      }
    },
  });
}

/** Tool names for this package */
export const SCHEDULE_TOOL_NAMES: ReadonlySet<string> = new Set([
  "schedule_task",
  "cancel_task",
]);
