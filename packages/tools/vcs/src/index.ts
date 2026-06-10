import type { Shell } from "@agent-core/core";
import { z } from "zod";
import { defineTool } from "@agent-core/tools-common";
import type { Tool } from "@agent-core/tools-common";

const CAP_SHELL_EXEC = "shell:exec";

/**
 * Collect stdout from a Shell.exec call into a single string.
 */
async function collectStdout(shell: Shell, cmd: string, cwd?: string): Promise<{ stdout: string; exitCode: number }> {
  const chunks: string[] = [];
  let exitCode = 0;
  for await (const event of shell.exec(cmd, { cwd })) {
    if (event.type === "stdout") chunks.push(event.data);
    else if (event.type === "stderr") chunks.push(event.data);
    else if (event.type === "exit") exitCode = event.code;
  }
  return { stdout: chunks.join(""), exitCode };
}

const MAX_OUTPUT = 20000;

function truncate(output: string, limit: number = MAX_OUTPUT): { text: string; truncated: boolean } {
  if (output.length <= limit) return { text: output, truncated: false };
  return { text: output.slice(0, limit) + "\n... [truncated]", truncated: true };
}

// ──────────────────────────────────────────────
// git_status — structured file change list
// ──────────────────────────────────────────────

const statusSchema = z.object({
  cwd: z.string().optional().describe("Working directory (default: cwd)."),
});

export function createGitStatusTool(shell: Shell): Tool {
  return defineTool({
    name: "git_status",
    description: "Get structured git status: list of changed files with status codes (added/modified/deleted/renamed).",
    schema: statusSchema,
    requires: [CAP_SHELL_EXEC],
    riskTier: "READ_ONLY",
    run: async ({ cwd }) => {
      try {
        const { stdout, exitCode } = await collectStdout(shell, "git status --porcelain", cwd);
        if (exitCode !== 0) {
          return { modelContent: `git_status failed (exit ${exitCode}): ${stdout}`, isError: true };
        }
        const lines = stdout.split("\n").filter((l) => l.trim());
        const files = lines.map((line) => {
          const indexStatus = line[0] ?? " ";
          const workTreeStatus = line[1] ?? " ";
          const path = line.slice(3);
          return { path, indexStatus, workTreeStatus };
        });
        const summary = files.length === 0
          ? "Working tree clean."
          : `${files.length} changed file(s):\n${files.map((f) => `  [${f.indexStatus}${f.workTreeStatus}] ${f.path}`).join("\n")}`;
        return {
          modelContent: summary,
          displayMetadata: { files, count: files.length },
        };
      } catch (err) {
        return { modelContent: `git_status failed: ${err instanceof Error ? err.message : String(err)}`, isError: true };
      }
    },
  });
}

// ──────────────────────────────────────────────
// git_diff — structured diff output
// ──────────────────────────────────────────────

const diffSchema = z.object({
  args: z.string().optional().describe("Extra args for git diff (e.g. 'HEAD~1' or '--cached')."),
  cwd: z.string().optional().describe("Working directory."),
});

export function createGitDiffTool(shell: Shell): Tool {
  return defineTool({
    name: "git_diff",
    description: "Get structured git diff output. Returns file changes with +/- lines.",
    schema: diffSchema,
    requires: [CAP_SHELL_EXEC],
    riskTier: "READ_ONLY",
    run: async ({ args, cwd }) => {
      try {
        const cmd = `git diff ${args ?? ""}`.trim();
        const { stdout, exitCode } = await collectStdout(shell, cmd, cwd);
        if (exitCode !== 0) {
          return { modelContent: `git_diff failed (exit ${exitCode}): ${stdout}`, isError: true };
        }
        const { text, truncated } = truncate(stdout);
        const prefix = truncated ? "[truncated] " : "";
        return {
          modelContent: `${prefix}${text || "(no diff)"}`,
          displayMetadata: { diff: stdout, truncated, args },
        };
      } catch (err) {
        return { modelContent: `git_diff failed: ${err instanceof Error ? err.message : String(err)}`, isError: true };
      }
    },
  });
}

// ──────────────────────────────────────────────
// git_commit — commit with structured result
// ──────────────────────────────────────────────

const commitSchema = z.object({
  message: z.string().describe("Commit message."),
  cwd: z.string().optional().describe("Working directory."),
});

export function createGitCommitTool(shell: Shell): Tool {
  return defineTool({
    name: "git_commit",
    description: "Create a git commit. Returns the commit hash. Requires all changes to be staged first.",
    schema: commitSchema,
    requires: [CAP_SHELL_EXEC],
    riskTier: "WRITE_HIGH",
    run: async ({ message, cwd }) => {
      try {
        // Use stdin to pass the commit message, avoiding shell interpretation
        // of metacharacters ($, `, ;, etc.) that would be unsafe with -m flag.
        const cmd = `echo '${message.replace(/'/g, "'\\''")}' | git commit -F -`;
        const { stdout, exitCode } = await collectStdout(shell, cmd, cwd);
        if (exitCode !== 0) {
          return { modelContent: `git_commit failed (exit ${exitCode}): ${stdout}`, isError: true };
        }
        // Extract commit hash from output
        const hashMatch = stdout.match(/\[[\w]+ ([a-f0-9]+)\]/);
        const hash = hashMatch?.[1] ?? "unknown";
        return {
          modelContent: `Committed: ${hash}\n${stdout.trim()}`,
          displayMetadata: { hash, message, stdout },
        };
      } catch (err) {
        return { modelContent: `git_commit failed: ${err instanceof Error ? err.message : String(err)}`, isError: true };
      }
    },
  });
}

// ──────────────────────────────────────────────
// git_push — push (IRREVERSIBLE, triggers ask)
// ──────────────────────────────────────────────

const pushSchema = z.object({
  remote: z.string().optional().describe("Remote name (default: origin)."),
  branch: z.string().optional().describe("Branch name (default: current branch)."),
  cwd: z.string().optional().describe("Working directory."),
});

export function createGitPushTool(shell: Shell): Tool {
  return defineTool({
    name: "git_push",
    description: "Push commits to a remote. This is an irreversible operation.",
    schema: pushSchema,
    requires: [CAP_SHELL_EXEC],
    riskTier: "IRREVERSIBLE",
    run: async ({ remote, branch, cwd }) => {
      try {
        const cmd = `git push ${remote ?? "origin"} ${branch ?? ""}`.trim();
        const { stdout, exitCode } = await collectStdout(shell, cmd, cwd);
        if (exitCode !== 0) {
          return { modelContent: `git_push failed (exit ${exitCode}): ${stdout}`, isError: true };
        }
        return {
          modelContent: `Pushed successfully.\n${stdout.trim() || "(success)"}`,
          displayMetadata: { remote: remote ?? "origin", branch, stdout },
        };
      } catch (err) {
        return { modelContent: `git_push failed: ${err instanceof Error ? err.message : String(err)}`, isError: true };
      }
    },
  });
}

// ──────────────────────────────────────────────
// run_tests — parse test output for pass/fail
// ──────────────────────────────────────────────

const testSchema = z.object({
  command: z.string().describe("Test command to run (e.g. 'pnpm test' or 'jest --ci')."),
  cwd: z.string().optional().describe("Working directory."),
});

export function createRunTestsTool(shell: Shell): Tool {
  return defineTool({
    name: "run_tests",
    description: "Run a test command and return structured pass/fail results with failing test names.",
    schema: testSchema,
    requires: [CAP_SHELL_EXEC],
    riskTier: "READ_ONLY",
    run: async ({ command, cwd }) => {
      try {
        const { stdout, exitCode } = await collectStdout(shell, command, cwd);
        const { text, truncated } = truncate(stdout);

        // Try to parse common test output patterns
        const passMatch = text.match(/(\d+)\s+pass/);
        const failMatch = text.match(/(\d+)\s+fail/);
        const testsMatch = text.match(/Tests:\s+(\d+)\s+passed.*?(\d+)\s+failed/s);
        const passed = testsMatch?.[1] ? parseInt(testsMatch[1]) : passMatch?.[1] ? parseInt(passMatch[1]) : undefined;
        const failed = testsMatch?.[2] ? parseInt(testsMatch[2]) : failMatch?.[1] ? parseInt(failMatch[1]) : undefined;
        const success = exitCode === 0;

        const summary = success
          ? `Tests passed.${passed !== undefined ? ` (${passed} passed)` : ""}`
          : `Tests failed (exit ${exitCode}).${failed !== undefined ? ` (${failed} failed)` : ""}`;

        return {
          modelContent: `${summary}\n${text}`,
          displayMetadata: { exitCode, passed, failed, success, truncated, stdout: text },
        };
      } catch (err) {
        return { modelContent: `run_tests failed: ${err instanceof Error ? err.message : String(err)}`, isError: true };
      }
    },
  });
}

// ──────────────────────────────────────────────
// build — run build command, parse success/fail
// ──────────────────────────────────────────────

const buildSchema = z.object({
  command: z.string().describe("Build command to run (e.g. 'pnpm build' or 'tsc')."),
  cwd: z.string().optional().describe("Working directory."),
});

export function createBuildTool(shell: Shell): Tool {
  return defineTool({
    name: "build",
    description: "Run a build command and return success/failure with error summary.",
    schema: buildSchema,
    requires: [CAP_SHELL_EXEC],
    riskTier: "READ_ONLY",
    run: async ({ command, cwd }) => {
      try {
        const { stdout, exitCode } = await collectStdout(shell, command, cwd);
        const { text, truncated } = truncate(stdout);
        const success = exitCode === 0;

        const summary = success
          ? "Build succeeded."
          : `Build failed (exit ${exitCode}).`;

        return {
          modelContent: `${summary}\n${text}`,
          displayMetadata: { exitCode, success, truncated, stdout: text },
        };
      } catch (err) {
        return { modelContent: `build failed: ${err instanceof Error ? err.message : String(err)}`, isError: true };
      }
    },
  });
}

// ──────────────────────────────────────────────
// Tool names set
// ──────────────────────────────────────────────

export const VCS_TOOL_NAMES: ReadonlySet<string> = new Set([
  "git_status",
  "git_diff",
  "git_commit",
  "git_push",
  "run_tests",
  "build",
]);

export const CAP_VCS_EXEC = CAP_SHELL_EXEC;
