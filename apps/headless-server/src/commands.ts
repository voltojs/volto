/**
 * Built-in slash commands served to the web app's command menu (GET /commands)
 * and registered into every agent instance via createAgent({ commands }), so
 * SDK resolveInput() expands "/name args" through renderCommand. Positional
 * args land under key "0" (see sdk parseArgs). Action-style commands like
 * /clear live entirely in the web client and must NOT be listed here — the
 * server would answer "Unknown command".
 */
import type { SlashCommand } from "@volto/sdk";

export const BUILT_IN_COMMANDS: SlashCommand[] = [
  {
    name: "plan",
    description: "制定实施计划，确认后再执行",
    template:
      "请针对以下目标制定实施计划，先不要修改代码：列出分步方案、涉及文件与风险点，等我确认后再执行。目标：{{0}}",
  },
  {
    name: "review",
    description: "按严重程度审查代码改动",
    template:
      "请审查 {{0}} 的代码改动，按严重程度列出问题与修复建议；未指定范围时，审查当前项目最近未提交的改动。",
  },
  {
    name: "explain",
    description: "解释指定目标的实现",
    template: "请解释 {{0}} 的实现原理与关键代码路径。",
  },
];
