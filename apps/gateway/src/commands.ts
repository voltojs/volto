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
import type { SlashCommand } from "@voltojs/sdk";
import { t, type Locale } from "@voltojs/i18n";

const REVIEW_TEMPLATE =
  "Review the changes to {{0}} and list issues and fixes by severity; when no scope is given, review the current project's uncommitted changes.";
const EXPLAIN_TEMPLATE = "Explain how {{0}} is implemented and walk through its key code paths.";

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
