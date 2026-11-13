/** English counterpart of `zh.ts`; both files must carry the same key set. */
export const en = {
  "server.fork.branchName": "Branch",
  "server.fork.branchSuffix": " (branch)",
  "server.routingTier.advanced.label": "Advanced",
  "server.routingTier.advanced.description": "Most capable; complex tasks and deep reasoning",
  "server.routingTier.fast.label": "Fast",
  "server.routingTier.fast.description": "Low latency; quick questions and lookups",
  "server.routingTier.economy.label": "Economy",
  "server.routingTier.economy.description": "Cost-saving; batches and low-risk subtasks",
  "server.commands.review.description": "Review the current changes by severity",
  "server.commands.explain.description": "Explain how the target is implemented",
  "server.picker.chooseDirectory": "Choose a project folder",
  "server.error.exportFailed": "Could not export the session",
  "server.error.agentStarting": "The session's agent is still starting; try again in a moment",
  "server.steer.autoTurnLimit":
    "Stopped auto-running turns after 50 rounds; some queued messages are still undelivered",
  "server.queue.gone":
    "That queued message is no longer available — it may have already been delivered",
  "server.queue.emptyContent": "Message content cannot be empty",
  "server.queue.persistFailed": "Could not save the queue change; no changes were made — try again",
} as const;
