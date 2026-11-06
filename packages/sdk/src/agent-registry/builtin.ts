/**
 * Built-in sub-agent definitions — the routing floor below every file source.
 *
 * Before these existed, "general-purpose" was only an invisible fallback
 * branch (omit `subagent_type`), while the picker list showed whatever file
 * definitions happened to exist. Observed failure (session vl3ierhqx): the
 * parent model decided "general-purpose (omit)" in its reasoning but emitted
 * a specialist type in the actual arguments, and the task then ran under a
 * heavyweight debugging methodology nobody had asked for. A named, enum'd,
 * prompt-bearing entry point makes the right default choosable, and the
 * minimal role prompt fixes the second defect of the old fallback: an
 * untyped child started with NO system prompt at all — it did not know it
 * was a sub-agent, that the parent conversation is invisible to it, or that
 * its reply must stand on its own.
 *
 * Assembly rules, deliberately different from file definitions:
 * - Built-ins never run through `assembleSubAgent`'s policy narrowing. They
 *   declare no policy, so the child inherits the parent's resolved value
 *   exactly as the old omit path did — a built-in must not silently change
 *   the permission layer the parent configured.
 * - `tools` on a built-in is a filter over the parent's set (intersection
 *   semantics), never an independent grant.
 * - A file definition (user/project/plugin) with the same name shadows the
 *   built-in: the override only swaps the prompt and/or narrows tools; the
 *   intersection and narrowPermission rules keep it at or below the parent.
 */

import type { AgentSpec } from "../agent-spec.js";

/** Name of the inherit-everything default dispatch type. */
export const GENERAL_PURPOSE_NAME = "general-purpose";

/** Name of the read-only exploration dispatch type. */
export const EXPLORE_NAME = "explore";

/**
 * The shared sub-agent role prompt. Short on purpose: it carries only what
 * an isolated child cannot infer from the dispatch message — that it is a
 * sub-agent, that nothing above it can answer questions, and that the reply
 * must be self-contained and evidence-citing.
 */
const SUBAGENT_PREAMBLE = [
  "You are a sub-agent: a separate assistant instance dispatched to complete one self-contained task.",
  "You cannot see the parent conversation — the dispatch message is your entire task context — and no human can answer questions mid-run, so never stop to ask.",
  "",
  "Work the task end to end, then deliver a result that stands on its own: lead with the direct answer, keep it as short as the task allows, and cite file paths or evidence instead of dumping raw content. If part of the task cannot be completed, say plainly what blocked it.",
].join("\n");

/** Tool names kept for the read-only explorer (intersection over the parent). */
const EXPLORE_TOOLS: readonly string[] = [
  "read_file",
  "ls",
  "glob",
  "grep",
  "web_fetch",
  "web_search",
];

export const BUILTIN_GENERAL_PURPOSE: AgentSpec = {
  name: GENERAL_PURPOSE_NAME,
  description:
    "General-purpose sub-agent for self-contained research or multi-step tasks. Inherits the parent's tools, model and policy; give it explicit scope and depth in the message.",
  systemPrompt: SUBAGENT_PREAMBLE,
  // tools / capabilities / policy stay undefined: pure inheritance.
};

export const BUILTIN_EXPLORE: AgentSpec = {
  name: EXPLORE_NAME,
  description:
    "Fast read-only codebase explorer: locates files, reads code, greps and searches. Cannot modify files or run commands. Use for investigation where no side effect is acceptable.",
  systemPrompt: `${SUBAGENT_PREAMBLE}

You are read-only: your tools locate and read, they never modify files or execute commands. Prefer breadth (grep / ls / glob) before reading one file end to end, and report what you did not find as well as what you did.`,
  tools: [...EXPLORE_TOOLS],
};

/** All built-in definitions, lowest priority (every file source wins). */
export const BUILTIN_AGENTS: readonly AgentSpec[] = [
  BUILTIN_GENERAL_PURPOSE,
  BUILTIN_EXPLORE,
];

/** Resolve a built-in by name; undefined for anything else. */
export function findBuiltInAgent(name: string): AgentSpec | undefined {
  return BUILTIN_AGENTS.find((spec) => spec.name === name);
}
