---
title: What happens in a turn
type: concept
source:
  - packages/core/src/reducer.ts
  - packages/runtimes/node/src/runner.ts
  - packages/core/src/context-assembler.ts
generated: false
verified: 2026-11-11
---

# What happens in a turn

> After reading this you will: know which steps can stall once you send a message, and where to look when they do.

## The one-sentence version

You send a message → the context is assembled → the model is asked → the model either answers or asks for a tool → the tool runs and its result is put back → the model is asked again → … until the model asks for no more tools, and the turn ends.

## The expanded version

```text
You press Enter
   │
   ├─ Assemble the context: system prompt + tool descriptions + project instructions + history + your new message
   │                 (static parts first, dynamic parts last, to hit the cache)
   │
   ├─ Ask the model ──► the model streams text ──► the UI shows it as it arrives
   │                │
   │                └─ the model says "I want to call bash"
   │                      │
   │                      ├─ Is this tool visible to the model? (not visible → the model never mentions it)
   │                      ├─ Is this call allowed?  (needs asking → an approval card appears and waits)
   │                      ├─ Execute (in the sandbox)
   │                      └─ Put the result back into the context → ask the model again
   │
   └─ The model asks for no more tools → the turn ends
```

## A few commonly misunderstood points

**"Tool not visible" is not "tool rejected".** Visibility is decided at assembly time (if this machine has no shell, `bash` never appears in the model's tool list); rejection happens at execution time (the user clicks reject on the approval card). In the first case the model does not even know the tool exists; in the second it knows it was rejected and will try something else.

**A rejection does not break the conversation.** The rejection comes back to the model as a tool result, and it tries another path.

**The context gets compacted.** As the conversation grows, earlier messages are folded into a summary while recent ones stay verbatim. Compaction is automatic; you can also trigger it manually with `/compact`.

**The working directory and branch are injected as reminders.** If you `cd` to another directory mid-session, the model knows it on the next turn — you do not need to say it again.

## Where to look when it stalls

| Symptom | Where to look |
| --- | --- |
| No output at all | The model connection (provider / network) |
| Keeps "thinking" without acting | The model is generating a long reasoning chain, or retrying invalid tool-call arguments |
| Stuck on an approval card | It is waiting for your click |
| Calls the same tool over and over | The tool result does not give a clear "done" signal, or the description does not state the boundary |
| Suddenly starts forgetting things | The context was compacted and early details became a summary |