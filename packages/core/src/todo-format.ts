import type { TodoItem } from "./state.js";

function isTodoStatus(value: unknown): value is TodoItem["status"] {
  return value === "pending" || value === "in_progress" || value === "completed";
}

/**
 * One `todoListUpdated` snapshot, or `null` when the payload is malformed.
 *
 * The single validator for todo snapshots: `foldStandingTodos` and
 * `foldTodoTransitions` must agree on what counts as a valid list, otherwise
 * the dock and the progress lines would disagree about the same event.
 */
function parseTodoSnapshot(data: unknown): TodoItem[] | null {
  const raw = (data as { todos?: unknown } | null | undefined)?.todos;
  if (!Array.isArray(raw)) return null;
  const next: TodoItem[] = [];
  for (const item of raw) {
    if (typeof item !== "object" || item === null) return null;
    const content = (item as { content?: unknown }).content;
    const status = (item as { status?: unknown }).status;
    if (typeof content !== "string" || !isTodoStatus(status)) return null;
    next.push({ content, status });
  }
  return next;
}

/**
 * Standing plan from a durable event log: latest valid `todoListUpdated`
 * snapshot (last-write-wins). `null` when the session never wrote a list.
 * Malformed snapshots are ignored so a corrupt tail cannot wipe the plan.
 */
export function foldStandingTodos(
  events: ReadonlyArray<{ type: string; data: unknown }>,
): TodoItem[] | null {
  let todos: TodoItem[] | null = null;
  for (const event of events) {
    if (event.type !== "todoListUpdated") continue;
    const next = parseTodoSnapshot(event.data);
    if (next !== null) todos = next;
  }
  return todos;
}

export type TodoTransitionKind = "added" | "started" | "completed" | "reopened" | "removed";

/** One human-visible change between two consecutive todo snapshots. */
export interface TodoTransition {
  kind: TodoTransitionKind;
  content: string;
}

/** A transition anchored to the event that produced it. */
export interface TodoTransitionRecord {
  /** Owning turn, when the event carried one. */
  turn?: number;
  time: number;
  transition: TodoTransition;
}

/** Emission order of kinds within one snapshot: progress first, bookkeeping last. */
const TRANSITION_PHASE: readonly TodoTransitionKind[] = [
  "completed",
  "reopened",
  "started",
  "added",
  "removed",
];

/**
 * What changed between two snapshots, keyed by `content` (a `TodoItem` has no
 * id; equal content is the same item, matching `foldStandingTodos`'s
 * last-write-wins semantics).
 *
 * `prev === null` means "no baseline yet": the first snapshot only establishes
 * one, so nothing is reported. Output order is fixed by `TRANSITION_PHASE`,
 * then by `next` order within a phase (`removed` follows `prev` order), so a
 * caller can assert exactly one sequence.
 */
export function diffTodoSnapshots(
  prev: readonly TodoItem[] | null,
  next: readonly TodoItem[],
): TodoTransition[] {
  if (prev === null) return [];
  const prevByContent = new Map(prev.map((item) => [item.content, item.status]));
  const nextByContent = new Map(next.map((item) => [item.content, item.status]));

  const byKind = new Map<TodoTransitionKind, string[]>();
  const push = (kind: TodoTransitionKind, content: string): void => {
    const bucket = byKind.get(kind);
    if (bucket === undefined) byKind.set(kind, [content]);
    else bucket.push(content);
  };

  for (const item of next) {
    const before = prevByContent.get(item.content);
    if (before === undefined) push("added", item.content);
    if (before === item.status) continue;
    if (item.status === "completed") {
      push("completed", item.content);
      continue;
    }
    if (before === "completed") {
      push("reopened", item.content);
      continue;
    }
    if (item.status === "in_progress") push("started", item.content);
  }
  for (const item of prev) {
    if (!nextByContent.has(item.content)) push("removed", item.content);
  }

  const out: TodoTransition[] = [];
  for (const kind of TRANSITION_PHASE) {
    for (const content of byKind.get(kind) ?? []) out.push({ kind, content });
  }
  return out;
}

/**
 * Folds a durable event log into anchored transitions.
 *
 * `initial` is the baseline the first snapshot is diffed against — a resumed
 * session passes the last snapshot it already knows, so the next write still
 * reports its change. Without a baseline the first snapshot only seeds.
 */
export function foldTodoTransitions(
  events: ReadonlyArray<{ type: string; data: unknown; time?: number; turn?: number }>,
  initial: readonly TodoItem[] | null,
): TodoTransitionRecord[] {
  let prev: readonly TodoItem[] | null = initial;
  const out: TodoTransitionRecord[] = [];
  for (const event of events) {
    if (event.type !== "todoListUpdated") continue;
    const next = parseTodoSnapshot(event.data);
    if (next === null) continue;
    for (const transition of diffTodoSnapshots(prev, next)) {
      out.push({
        ...(event.turn !== undefined ? { turn: event.turn } : {}),
        time: event.time ?? 0,
        transition,
      });
    }
    prev = next;
  }
  return out;
}

/** Icon for one status. Shared by injection and (if needed) future UIs. */
export function todoStatusIcon(status: TodoItem["status"]): string {
  if (status === "completed") return "[x]";
  if (status === "in_progress") return "[~]";
  return "[ ]";
}

/**
 * Canonical model-facing standing-list text. Sole producer of the injection
 * layer body and `context_reminder` kind `todo_list`.
 */
export function formatTodoListForModel(todos: readonly TodoItem[]): string {
  if (todos.length === 0) return "";
  const header =
    "Current todo list (authoritative for this session; older todo_write tool history may be compressed away):";
  const lines = todos.map((t) => `- ${todoStatusIcon(t.status)} ${t.content}`);
  return [header, ...lines].join("\n");
}

/** Counts line for tool/model acks (core helper; tools may reimplement locally). */
export function formatTodoCounts(todos: readonly TodoItem[]): string {
  let pending = 0;
  let inProgress = 0;
  let completed = 0;
  for (const t of todos) {
    if (t.status === "pending") pending++;
    else if (t.status === "in_progress") inProgress++;
    else completed++;
  }
  return `Updated todo list: ${pending} pending, ${inProgress} in progress, ${completed} completed.`;
}
