/**
 * Built-in slash commands served to the web app's command menu (GET /commands)
 * and registered into every agent instance via createAgent({ commands }), so
 * SDK resolveInput() expands "/name args" through renderCommand. Positional
 * args land under key "0" (see sdk parseArgs). Action-style commands like
 * /clear and /plan live entirely in the web client and must NOT be listed
 * here — the server would answer "Unknown command" (/plan is intercepted
 * client-side, where it switches the session into plan mode; a server
 * template would dual-track it into a plain message without the mode
 * switch).
 */
import type { SlashCommand } from "@volto/sdk";
import { t, type Locale } from "@volto/i18n";

const REVIEW_TEMPLATE =
  "请审查 {{0}} 的代码改动，按严重程度列出问题与修复建议；未指定范围时，审查当前项目最近未提交的改动。";
const EXPLAIN_TEMPLATE = "请解释 {{0}} 的实现原理与关键代码路径。";

/** The command menu's copy, rendered for `locale` (the templates are
 * model-facing and stay language-independent of the UI). */
export function builtInCommands(locale: Locale): SlashCommand[] {
  return [
    {
      name: "review",
      description: t(locale, "server.commands.review.description"),
      template: REVIEW_TEMPLATE,
    },
    {
      name: "explain",
      description: t(locale, "server.commands.explain.description"),
      template: EXPLAIN_TEMPLATE,
    },
  ];
}

/** Default-locale copy, for callers with no request locale at hand. */
export const BUILT_IN_COMMANDS: SlashCommand[] = builtInCommands("zh");
