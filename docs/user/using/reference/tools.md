---
title: Tool reference
type: reference
generated: true
source:
  - packages/tools/src
verified: 2026-11-11
---
<!-- GENERATED FILE — do not edit by hand. Run `pnpm docs:gen`; hand edits are reported as drift by `pnpm docs:check`. -->

# Tool reference

Every tool the agent can call. **Tool visibility does not mean approval** — permission modes and approval cards are covered in [Permissions and approvals](../guides/permissions-and-approvals.md).

| Tool | Group | Purpose |
| --- | --- | --- |
| apply_patch | fs | Apply a unified diff; requires reading the same file first. |
| ask_user | ask | Ask the user a question and wait for an answer — for when requirements are vague or a human choice is needed. |
| bash | shell | Run shell commands, in a persistent session by default (cd and environment variables persist across turns). |
| bash_output | shell | Read incremental output from a background command without waiting for it to finish. |
| browser_click | browser | Click an element by the ref from a snapshot; when a ref is stale, have the agent take a new snapshot. |
| browser_diagnostics | browser | See recent console/page errors and failed/4xx/5xx requests, without response bodies. |
| browser_navigate | browser | Have the agent open an http(s) page, or go forward/back/reload; returns a page snapshot with refs. |
| browser_press_key | browser | Press a key on the page or the focused element (Enter, Escape, Tab, arrow keys, etc.). |
| browser_screenshot | browser | Capture the current page as PNG; the screenshot shows up in the trace as a tool result, and the thumbnail can be opened full-screen, zoomed, panned and downloaded. Requires attachment storage and an image model. |
| browser_snapshot | browser | Read the current page structure to get clickable/typable refs; prefer it for locating elements. |
| browser_storage_state | browser | Save the current login state (cookie/localStorage) to the configured path, for later sessions to reuse. |
| browser_type | browser | Fill an input by ref, optionally pressing Enter to submit. |
| browser_wait_for | browser | Wait for some text to appear or wait a while, then return a fresh snapshot. |
| build | vcs | Run one build with the given build command and return success/failure plus an error summary (the command is passed in by the caller). |
| cancel_task | schedule | Cancel a scheduled task. |
| db_exec | data | Run writing SQL; only available when the host grants write permission. |
| db_query | data | Run a read-only SQL query. |
| edit_file | fs | Modify a file by old/new text replacement; a forgiving match kicks in when the exact match fails. |
| git_commit | vcs | Commit the current changes as one commit. |
| git_diff | vcs | See the diff of the working tree or of a commit range. |
| git_push | vcs | Push the current branch to the remote. |
| git_status | vcs | See which files changed and how (structured status codes). |
| glob | fs | Find files by filename pattern, sorted by modification time. |
| grep | fs | Search file contents by regular expression, optionally limited by directory and file type. |
| http_query | data | Send a custom HTTP request (method, headers and body can all be specified). |
| kill_shell | shell | End a background command. |
| list_watches | fs | List the currently registered file watches. |
| ls | fs | List directory contents. |
| lsp_definition | code | Jump to the definition of a symbol. |
| lsp_diagnostics | code | Get the type / syntax errors reported by the language server. |
| lsp_hover | code | See a symbol's type signature and documentation. |
| lsp_references | code | Find every place a symbol is referenced. |
| lsp_rename | code | Preview where a rename would make changes (nothing is written to disk). |
| memory | memory | Read and write long-term memory across sessions: search by keyword, write one memory. |
| multi_edit | fs | Make several replacements in the same file, all or nothing. |
| read_document | document | Read PDF / DOCX / XLSX / images and convert them to text. |
| read_file | fs | Read a file (with line numbers); also reads images and PDF pages. |
| run_tests | vcs | Run the given test command, parse common test output and list the names of failing cases (the command is passed in by the caller). |
| schedule_task | schedule | Schedule a delayed task that wakes the session when it is due. |
| skill | skill | Load the full instructions of a skill package. |
| task | agent | Dispatch a subagent for an independent subtask; if acceptance criteria are given they are judged on completion, and a failure triggers one automatic rework by default. |
| task_output | agent | Get the result of a subagent task. |
| todo_write | plan | Maintain a todo list for the current task so progress is visible to both the human and the model. |
| unwatch_files | fs | Stop a file watch. |
| watch_files | fs | Watch files or directories for changes. |
| web_fetch | web | Fetch the body text of a web page. |
| web_search | web | Search the web. |
| write_file | fs | Create or fully overwrite a file; overwriting an existing file requires reading it first. |

48 tools in total. Groups map to `packages/tools/<group>`; tools in the same group share a permission capability.

> Generated by `pnpm docs:gen`: the purpose text comes from `docs/user/reference/tool-notes.json`; a new tool without an entry makes `pnpm docs:check` fail.
