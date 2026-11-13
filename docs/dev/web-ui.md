---
title: Web UI
status: current
source:
  - apps/web
verified: 2026-11-13
supersedes:
  - docs/archive/superpowers/specs/2026-09-05-web-trajectory-view-design.md
  - docs/archive/superpowers/specs/2026-09-12-right-pane-design.md
  - docs/archive/superpowers/specs/2026-09-15-agent-todos-design.md
  - docs/archive/superpowers/specs/2026-09-15-web-background-tasks-design.md
  - docs/archive/superpowers/specs/2026-11-03-clickable-file-links-design.md
  - docs/archive/superpowers/specs/2026-11-03-web-i18n-design.md
  - docs/archive/superpowers/specs/2026-11-04-file-ref-annotations-design.md
  - docs/archive/superpowers/specs/2026-11-04-web-steering-queued-messages-design.md
  - docs/archive/superpowers/specs/2026-11-06-turn-file-diff-design.md
---

# Web UI

## Scope and where it sits

`apps/web` is the browser client for a running gateway: a Next.js App Router application
(Next 16, React 19, Tailwind 4) whose client infrastructure is zustand stores (`stores/`),
an SSE transport (`lib/agent-config.ts`, `hooks/use-chat-agent.ts`) and a projection layer
that turns transcript events into rendered rows (`lib/projection.ts`). It contains no agent
logic: decisions arrive already made as events on a per-session SSE channel, and every
action is an HTTP call. The bundle deliberately imports only the `@voltojs/sdk/sse` and
`@voltojs/sdk/file-refs` subpaths, whose dependency subtree is protocol types and pure
helpers; the package root would drag Node-only packages in.

Two build shapes exist (`apps/web/next.config.ts`). `VOLTO_WEB_EXPORT=1` (the `export`
script behind `pnpm web:export`) sets `output: 'export'`, `trailingSlash: true` and
`distDir: 'out'`: plain files with no server render, no rewrite table and no cookie to
read. Without it (`pnpm dev`, port 6100) the app is a dev server rewriting `/gateway/*` to
`NEXT_PUBLIC_AGENT_SERVER_URL ?? http://localhost:3100`.

Because the exported build cannot bake in a deployment address, `lib/gateway-base.ts`
resolves it at runtime — `localStorage["volto.gatewayUrl"]`, then
`window.__VOLTO_CONFIG__.gatewayUrl` (from the head-loaded `public/volto-config.js`), then
`/gateway` under `next dev` and `''` (same origin) otherwise — and memoizes the answer for
the page's life, so a `localStorage` change applies on the next load. Authentication is a
cookie on the single origin the browser sees: `credentials: 'include'` on every `fetch`,
`withCredentials: true` on the `EventSource`.

Boot order (`app/layout.tsx`) is part of the design: the static shell renders
`<html lang="zh-CN" suppressHydrationWarning>` and three head scripts — sidebar-width
restore (`sidebarWidthRestoreScript`), a synchronous `volto-config.js` load, and
`browserBootScript`. The last decides locale and theme from cookies /
`navigator.languages` while HTML parses, writes `data-volto-locale`, `data-volto-theme`,
`lang`, the `dark` class, `color-scheme` and the config default, and the shell reads those
back via `readBrowserBoot` so the first client render matches the screen. `app/page.tsx`
therefore imports `AppShell` with `ssr: false`.

`lib/agent-config.ts` and the `lib/*-api.ts` clients cover the rest: one long-lived
`GET /events?sessionId=` channel per open session, `POST /messages` (start a turn, or
enqueue mid-turn with 202), `POST /messages/queue` (edit / retract a queued message),
`POST /interrupt` (409 when nothing runs), `POST /approvals` (needs the channel's
connection token), and reads under `/sessions*`, `/sessions/:id/trajectory`,
`/sessions/:id/events`, `/file-refs`, `/fs/*`, `/git/*`, `/plan`, `/commands`, `/skills`,
`/preferences`, `/config/*`, `/gateway-info`.

## Current behavior (layout, panes, chat/trajectory, diffs, steering, file refs)

### Layout

`app/app-shell.tsx` mounts `I18nProvider` → `LocalePreferenceSync` →
`CapabilitiesBoot` → `ThemeProvider` → `TooltipProvider`, then a single full-height row
with `Sidebar` and `ChatPanel`, plus the `Toaster`.

`Sidebar` renders pinned sessions and project sections; the layout document (pins, order,
sort modes, collapse flags) lives on the gateway and is mirrored by
`stores/sidebar-state-store.ts` through `lib/sidebar-state-api.ts`, while the pixel width
is `localStorage["volto.sidebar.width"]`, published pre-paint into
`--volto-sidebar-width` by `sidebarWidthRestoreScript`. Its bottom row carries the
connection indicator, theme toggle and settings entry.

`ChatPanel` is the content column: `ChatHeader` (title = session title → project name →
welcome tagline; new-conversation, fork, rewind-to-turn, export, compact, and a
pane-expand control that only exists while the pane is hidden), an offline banner when
`connectionState !== 'connected'`, then a `Tabs` host with two tabs — `chat` and
`trajectory`. The active tab is local component state, so switching sessions keeps the
user where they were (the pane, not this tab, is what carries per-session memory). The
welcome screen replaces the feed while `entries.length === 0` and exposes project / model
/ permission pickers and the composer; the input stack is only rendered in the `chat` tab.

The chat tab is two stacked layers inside a full-width scroller: a `ConversationColumn`
(`max-w-7xl`) holding `MessageList`, any `ApprovalCard`s and the `TodoDock`; and, pinned
below the scroller at the same width, `QueuedDock`, `InputBar` and a status bar
(`SessionStatsChip`, `ConversationUsageChip`, `ContextMeter`). The scrollbar belongs to the
outer layer so it hugs the pane edge, not the column edge.

`InputBar` is a tiptap editor (single paragraph, `Enter` sends, `Shift+Enter` breaks) with
attachment chips, a `/` command menu and an `@` file-mention menu. `lib/input-commands.ts`
splits the slash menu: action commands (`/plan`, `/clear`, `/compact`) are intercepted
client-side and never sent, template commands come from `GET /commands`, skills from
`GET /skills` filtered to `userInvocable`.

### Chat feed

Entries (`ChatEntry` in `lib/projection.ts`) are `message` | `error` | `notice`.
`lib/feed-groups.ts` (`groupFeedEntries`) splits the feed at answer text: every text or
image block becomes its own `answer` row, and the reasoning and tool calls between two
answer rows merge into one `activity` row — across message boundaries, because a message
boundary is an artefact of how the model was called, not of the work. The footer (time,
copy, usage) rides the row holding the message tail. `MessageList` renders `AnswerRow`,
`ActivitySteps` and `MessageBubble`, scrolls to the bottom on new entries, shows
`WaveLoading` while a turn runs, and appends a `FileChangesCard` after the last row of
each finished turn.

Approvals are part of the feed's tail rather than a modal: `selectPendingApprovals`
(`lib/approvals.ts`) folds pending `tool_use` blocks out of the main buffer,
`ApprovalCard` renders one per call, and `ChatPanel.handleDecide` posts the verdict with
the connection token from `getApprovalToken()`. A 409 means the card was stale and simply
disappears.

Todos are rendered as `TodoDock` under the feed, not as conversation messages: the live
fold `foldTodosFromEvents` (a re-export of the SDK's `foldStandingTodos`) wins when the
buffer has any `todoListUpdated`, otherwise the seed from `GET /sessions/:id` is used.

### Right pane

`components/pane/RightPane.tsx` is a tabbed shell with no knowledge of tab content: it
reads `usePaneStore`, renders a horizontally scrollable tab strip (icon, title, close) plus
a collapse control at its far right, and dispatches the active tab through
`PANE_TAB_RENDERERS`. `PaneTab` (`stores/pane-store.ts`) is a discriminated union:

| kind | payload | body |
| --- | --- | --- |
| `subagent` | `childSessionId`, `view: 'chat' \| 'trajectory'`, optional `parentSessionId`, `title`, `agentType` | `SubagentTab` |
| `files` | `projectId` | `FileTreeTab` |
| `file-preview` | `projectId`, `path`, optional `line` / `endLine` | `FilePreviewTab` |
| `file-diff` | `projectId`, `path`, `turn`, `diff`, counts, `edits`, optional `truncated` | `FileDiffTab` |
| `git-graph` | `projectId` | `GitGraphTab` |
| `tasks` | singleton id `tasks` | `BackgroundTasksTab` |
| `plan` | `sessionId` | `PlanPane` |

State rules worth naming: `open` and `hidden` are separate (collapsing keeps tabs, closing
the last tab leaves the empty overview mounted — a reversal of the original
close-last-tab-hides-the-pane rule); width is clamped to 320–720 px, default 420, stored
under `volto.pane.width`; `openTab` dedupes by tab id and refreshes payloads in place for
`file-preview` (new line target), `file-diff` (later edit in the same turn) and `subagent`
(view flip, preserving `parentSessionId`). Per-session pane state is snapshotted into
`localStorage["volto.pane.sessions"]` (LRU cap 100 entries / 2 MB) by the subscriber and
restored on `bindSession`, so a refresh or a switch back restores the same tabs — this
contradicts the earlier "tabs are memory-only" decision. `retargetProjectTabs` keeps
`subagent` / `tasks` / `plan` tabs across a workspace switch, retargets `files` /
`git-graph`, and drops path-based tabs.

`SubagentTab` is a two-view body driven by the payload's `view`: the child feed
(`useSubagentConversation`, disk events merged with the live bucket) and a stored-only
trajectory list (`useStoredRows`). Continued chat at its bottom uses
`useSubagentChatAgent`, inheriting project and permission from `parentSessionId`; the model
defaults to the one the child's last usage-bearing turn actually ran on, with local-only
overrides for model / effort / permission. `BackgroundTasksTab` lists the session's
sub-agent dispatches from `collectBackgroundTasks` — the same projection the
`SubagentCard`s use — and `useAutoOpenTasksTab` opens it once per session on a 0 → ≥1
transition observed *after* the detail loaded (restored history never opens it). The
`plan` tab body fetches the plan and renders `PlanPane`; "execute" switches the session to
`planPreviousMode ?? 'ask'` and sends the approval message through the normal send path.

### Trajectory

The `trajectory` tab hosts `TrajectoryPanel`. Rows come from two sources,
`hooks/use-trajectory.ts`: stored rows from `GET /sessions/:id/trajectory` (lazily fetched,
cached per session in `lib/trajectory-cache.ts`, cache dropped when the session is switched
away from) and live rows from `projectTrajectory` over the chat buffers. `mergeStoredAndLiveRows`
keeps live rows on id collisions, drops stored duplicates by id or by a
`kind:turn:step:startedAt:summary` content key (the two sides can number event seqs
differently), sorts by `startedAt` and renumbers `index`. A 410 maps to a non-retryable
"legacy transcript" message; network failures get a retry button.

Rows are `#index`, a kind badge, the summary, a location (`turn N · step M`), an image
marker, a pulse dot for the streaming row and a duration. Clicking one opens
`TrajectoryDrawer` through the global `useTrajectoryDrawerStore`; the drawer's tabs come
from `drawerTabsFor` (tool/subagent: overview, input, output, schema, timing; assistant:
overview, request, output, thinking, timing; context: overview, layers, schema; user:
overview, content; reminder/compaction: overview, output). Two reversals: the drawer is
still a drawer rather than the planned `trajectory-detail` / `trajectory` pane tab kinds,
and a subagent row's "view process" opens a `subagent` pane tab with `view: 'trajectory'`
instead of replacing the list with the child's rows and a breadcrumb.

### Diffs

Diffs come from the write tools, not from git. A write tool captures its own unified diff
into the tool result's `displayMetadata.fileChange`, core exposes it as
`ConversationToolCall.fileChange`, and `lib/turn-file-changes.ts`
(`collectTurnFileChanges`) folds the feed into per-turn, per-file entries: repeated edits
of one file add up counts, concatenate hunks, count `edits`, and cap the body at
`MAX_TURN_FILE_DIFF_CHARS` (40 000) with `truncated: true`. `FileChangesCard` renders
"edited N files" with `+A -D` after the turn's last row, and only once the turn has
finished — the turn in flight shows nothing so the card is a conclusion, not a progress
indicator. Each row opens `openFileDiffTab`, which builds a `file-diff` tab keyed
`diff:${projectId}:${turn}:${path}`; the body travels in the payload, so the pane needs no
request and a reload replays the same hunks. `FileDiffTab` renders `parseUnifiedDiff`
output (dual line numbers, `+`/`-` colouring, `@@` markers, truncation notice) and offers
an "open file" hop into a `file-preview` tab.

### Steering

Sending while a turn runs is a steer, not an error: `useChatAgent.sendMessage` has no
`isGenerating` guard, posts `POST /messages`, gets a 202, and the queued entry comes back
as a `steering_queued` event. Nothing is echoed optimistically, locally or remotely — the
server's own `user_message` / `steering_*` events are the only source of user bubbles.

`lib/projection.ts` owns the web's queue fold, deliberately separate from core's record
fold because core places entries at their delivery point while the web places them at
their send position. `ownedBySteeringFold` removes id-carrying `steering_queued` /
`steering_edited` / `steering_removed` / `steering_delivered` from the record events, and
`foldSteeringQueue` replays them FIFO into entries that `insertQueuedMessages` interleaves
by timestamp (equal timestamps keep the already-folded message first). `resolveQueuedTurns`
stamps each entry with the turn it follows once the merged feed is known, and `queued` is
the only state the UI reads: while true the message renders in `QueuedDock` above the
composer, and after `steering_delivered` it renders in the flow at its send position with
no badge. `QueuedDock` mutates nothing locally — edit and retract call `updateQueue`
(`POST /messages/queue`) and wait for the `steering_edited` / `steering_removed` receipt,
with a 409 surfacing the "no longer available" notice. Editing is a multiline textarea
that refuses a trim-empty draft; Enter inserts a newline, and attachments are shown but not
editable.

Cold loads seed the fold from the server: `GET /sessions/:id` returns `queuedMessages`,
`selectQueuedSeed` drops ids the stored feed already renders, and the seed pre-fills the
fold so a reloaded page still shows its queue. A stored snapshot that still carries
`queued: true` triggers one forced detail refresh (`needsQueueResync`), because delivery or
retraction that happened while this client was detached produced no events it could see.

### File references

Three surfaces open the right pane's file preview, all through `openFileRef` /
`openFilePreview`, which keep one tab per `projectId + path` and update the line target in
place:

- Tool rows: `ToolCallCard` asks `toolCallFileRef` (`@voltojs/sdk/file-refs`) whether the
  call names a project file.
- Prose inline code and relative links: annotation-driven only. `Markdown` takes the host's
  `refs: RefAnnotation[]` for the block; an inline code node becomes a `FileRefChip` only
  when its character offsets in the block's own `content` fall inside a host-confirmed
  annotation. The renderer never guesses from the code text itself, which retires the
  earlier regex-recognition rule for body text (that regex survives only in the shared SDK
  module, for structured call args and link hrefs).
- The file tree and the diff tab, which open previews directly.

Annotations are fetched by `useFileRefs` on mount, on session change and after each settled
turn (keyed on `selectLastTurnEnd`, including the sub-agent bucket when the feed is a
child's), stored per session in `useFileRefsStore`, and sliced per row key for
`MessageList`. Failures are silent: no annotations means plain text, never an error row.
A `null` project id makes chips inert rather than guessing an owner.

## State and event flow (SSE → store → components)

```text
GET /events (EventSource, cookies) ─► createSSEClient ─► useChatAgent
   ├─ eventChildId() ─► chat-store.pushSubagentEvent / pushSubagentDelta
   └─ main feed      ─► chat-store.pushEvent / pushDelta
useConversation ─► projectConversation ─► mergeStoredAndLive ─► composeChatEntries
                └─► groupFeedEntries ─► MessageList / QueuedDock / status chips
```

`stores/chat-store.ts` holds the whole transport-visible state for one session: `events`
(authoritative), `deltas` (streaming increments), `isGenerating`, `currentSessionId`,
`subagents` (one `SubagentBucket` per `childSessionId`), `connectionState` and `notices`.
`pushEvent` appends and clears `deltas` when the event is an `assistant_message` — the
authoritative copy supersedes whatever was streaming. `pushDelta` only appends. The same
two rules apply inside a sub-agent bucket. Routing is by `lib/subagent-routing.ts`:
`agentDepth > 0` frames go to the child named by `childSessionId`, or to the
`UNTAGGED_BUCKET` (`_`) when a refreshed ring buffer lost the tag; everything else,
including the `subagent_started` / `subagent_finished` brackets, stays on the main feed and
the brackets additionally open and close the child's bucket.

`useChatAgent.ensureConnection` owns `turn_start` / `turn_end` (generating flag plus
`session.running`), `session_meta` (title updates), tier-fallback notices
(`tierNoticeFromEvent`), and pre-stream `error` frames (pushed as an `error` event and
used to release the composer). It waits for `connected` with a 10 s timeout, then calls
`syncRunningTurn`: `GET /sessions/:id/events?tail=1` returns the events after the last
`turn_end` plus a `running` flag; the tail is merged in front of whatever already arrived
via `mergeEventTail` (dedupe by type/time/turn/step/data), and `isGenerating` is set only
if the buffer's last `turn_start` is newer than its last `turn_end` — the flag alone is not
trusted. `useChatAgent` sets the global `connectionState`; the sidebar and `ChatPanel`
observe the same field.

`useConversation` composes what the UI renders: it projects `projectConversation(events,
deltas, t, queuedSeed)`, merges the active session's in-memory snapshot with the live
projection (`mergeStoredAndLive`, live wins on id collisions, ordered by timestamp), then
composes `ChatEntry[]` through `composeChatEntries`. That last step is where failure
semantics live: a step that errored before any `assistant_message` keeps its streamed text
but stops presenting itself as streaming and gains an error row; an empty closed assistant
message is dropped unless it carries the round's usage; turn-level errors that no message
already reported trail the feed as notices; cancelled turns get a neutral "interrupted"
notice spliced after their own entries, not appended at the bottom; session-level notices
(tier fallbacks) trail everything.

The store's buffer belongs to exactly one session. On a session switch `useConversation`
flushes the outgoing feed into the memory-only session store, then clears the buffer,
resets sub-agents and drops the outgoing session's trajectory cache. Session history
itself is never written to disk or `localStorage`: `ensureSessionDetail` (`GET
/sessions/:id`) seeds `messages`, `contextUsage`, `todos` and `queuedMessages`, and the
gateway's transcript stays the single durable copy. Context usage is
`projectContextUsage(seed, events)`; `null` means nothing to anchor on and the meter does
not render at all.

Sub-agent panes have their own flow: `useSubagentConversation` merges the child's disk
events (`GET /sessions/:id/events`, cached in `lib/subagent-cache.ts`) with its live bucket
and runs the same `composeChatEntries`, while `useSubagentChatAgent` opens a second,
child-scoped SSE channel for continued turns with its own per-child `isGenerating` flag.

## Internationalization

Two shipped languages, `zh` and `en`, defined once in `@voltojs/i18n`
(`packages/i18n/src/index.ts`) with `DEFAULT_LOCALE = 'zh'`. That package holds copy the
*server* produces (`server.*` keys, rendered through `t(locale, key, params)` or shipped as
a `TextRef { key, params?, fallback? }`), so one phrase has one translation across gateway
and browser. UI copy lives in `apps/web/messages/{en,zh}/` split into six namespaces
(`common`, `chat`, `sidebar`, `pane`, `settings`, `trajectory`), from 4 keys in `common` to
about 230 in `chat` and `settings`.

`i18n/messages.ts` is the single mapping: `NAMESPACES`, `MESSAGES: Record<Locale,
Record<Namespace, AbstractIntlMessages>>`, and `resolveInitialLocale({ cookie, languages
})` (stored `volto_locale` cookie, then the first shipped primary subtag of
`navigator.languages`, then the default). Both locales are imported statically, because an
exported build has no request to select messages with; the cost is that both catalogs ship
in the bundle — a reversal of the "only the current locale's namespaces reach the client"
decision.

`components/i18n-provider.tsx` keeps the active locale in React state and renders
`NextIntlClientProvider`; `commitLocale` writes `document.documentElement.lang` and the
`volto_locale` cookie (one year, `samesite=lax`). Switching language is a state change —
no navigation, no `router.refresh()` — which is what makes it work without a server.
`LocalePreferenceSync` reconciles the two sources: the page can only see the cookie, so
once `preferences.locale` arrives from the gateway it wins and rewrites the cookie. The
`pre-boot` script in `lib/browser-boot.ts` applies the same rule before first paint.

Guardrails:

- `apps/web/__tests__/message-catalogs.test.ts` asserts `zh` and `en` carry identical key
  sets per namespace; `english-render.test.tsx` renders a real component under the `en`
  catalog, while the rest of the suite runs against `zh` through `vitest.setup.ts`.
- `scripts/check-i18n-hardcoded.mjs` (`pnpm check:i18n`) fails on CJK string literals in
  production `.ts`/`.tsx`, ignoring comments, catalogs and tests.
- Model-visible text (system prompts, tool descriptions, command templates) is English by
  contract and deliberately not in either catalog.

## Invariants and boundaries

- **Server events are the only source of conversation content.** No optimistic user
  bubble; the bubble appears when the server echoes it.
- **One event buffer belongs to one session.** `chat-store.currentSessionId` gates
  projection (`bufferIsCurrent`); buffer and sub-agent buckets reset on switch, so nothing
  from one conversation can leak into another.
- **A queued message renders exactly once.** `queued` is the only switch between
  `QueuedDock` and the flow, and the web's fold owns id-carrying steering events so core's
  record fold cannot render them a second time.
- **A file chip means the host confirmed a file.** Prose chips require an annotation from
  `GET /file-refs`; an unknown owner (`null` project) renders inert, ambiguity plain text.
- **Diffs are captured, never recomputed client-side.** `file-diff` payloads come from the
  transcript's `fileChange`; the pane never shells out or reads the working tree.
- **Sub-agent traffic never touches the main feed.** Tagged frames go to their bucket; only
  the brackets stay, and they exist to open and close those buckets.
- **Failure degrades, it does not break the shell.** Pre-stream errors become feed rows,
  annotation fetches fail silently, legacy transcripts (410) show a message without a
  retry, corrupt `localStorage` is treated as empty.
- **Client persistence is view state only.** Browser storage holds pane width and
  per-session pane snapshots, sidebar width, the gateway override, the current session id
  and the locale/theme cookies. Transcripts, preferences, sidebar layout and workspace
  configuration are server-side.
- **The browser never imports the kernel.** Only `@voltojs/sdk/sse` and
  `@voltojs/sdk/file-refs` are allowed entry points; adding a root `@voltojs/sdk` import
  drags Node-only packages into the bundle.

## Decisions and rejected alternatives (with dates)

| Date | Decision here | Rejected alternative |
| --- | --- | --- |
| 2026-09-05 | Trajectory is a row list plus a detail drawer, fed by the live projection and the server's rows | Timeline overview, filters/search, virtual scrolling, and a full drill-down stack |
| 2026-09-12 | Right side is a platform: a `PaneTab` union, a `kind → component` registry, and a separate pane store | Embedding tab logic in the sub-agent pane; a dockable multi-split framework |
| 2026-09-12 | File browsing is read-only, with roots enforced server-side | A write endpoint and a client-side ignore-file parser |
| 2026-09-15 | Todos are `AgentState` data re-injected each turn and shown in a dock | Log-only folding, runner-side special-casing, or auto-clearing at turn start |
| 2026-09-15 | Background tasks are a pure view over the same tool-call projection the cards use | A second task registry with its own SSE/recovery path |
| 2026-11-03 | i18n is `next-intl` without routing; server copy travels as `TextRef` | Locale-prefixed routes; keeping two independent string sets |
| 2026-11-03 | File references in prose and tool rows open the pane | Browser navigation to the file, or linkifying bare paths |
| 2026-11-04 | Steering queues mid-turn input and injects it at the turn boundary; the queue is editable until delivery | The old 2 s BUSY drop, one turn per queued message, and optimistic echo |
| 2026-11-04 | Prose file identity comes from server-side facts (stat + session file set, turn-local first) | Client-side regex recognition with no identity check |
| 2026-11-05 | Queued messages live in a dock above the composer and join the flow on delivery | Inline queued bubbles in the conversation (superseded D16) |
| 2026-11-06 | Turn diffs come from tool-captured `displayMetadata.fileChange` | Server-side `git diff` (wrong scope, non-git projects) and per-turn workspace snapshots (extra storage, own diff engine) |

## How to change it (tests to run, contract impact)

```bash
pnpm turbo run typecheck lint test --filter @voltojs/web
pnpm check:i18n
pnpm web:export            # static export; also covered by __tests__/static-export.test.ts
```

`__tests__/static-export.test.ts` runs a real `next build` with `VOLTO_WEB_EXPORT=1` and
asserts `out/index.html` exists without a `/gateway` prefix, so it gates anything touching
URLs, routing or the boot scripts. Component specs run under jsdom (`.test.tsx`), pure
modules under node (`.test.ts`), and `vitest.setup.ts` mocks `next-intl` with the `zh`
catalogs.

Where the changes land:

- **UI copy** — add the key to *both* `messages/en/*.json` and `messages/zh/*.json` (the
  parity test fails otherwise) and read it with `useTranslations(namespace)`; never add a
  CJK literal outside the catalogs (`pnpm check:i18n`).
- **A new pane tab kind** — extend `PaneTab`, register the body in `PANE_TAB_RENDERERS`,
  add `tabIcon` / `tabTitleKey` cases plus a `pane.tabs.*` key in both locales, and decide
  what `retargetProjectTabs` does with it on a workspace switch. Body props are
  `{ tab, onExecutePlan? }`.
- **A new row or block type** — rows are split by `groupFeedEntries`, but the semantic
  grouping is `groupConversationBlocks` in `@voltojs/sdk/sse`, shared with the server, so a
  new block type is a contract change on both sides. Turn-end UI belongs in `MessageList`,
  which already knows each turn's last row and whether it is in flight.
- **A new SSE event or transcript field** — the type lives in `@voltojs/sdk/sse`; then a
  projection branch, a case in `ownedBySteeringFold` / `foldSteeringQueue` if the queue is
  affected, and a `chat-store` action if generating or connection state changes.
  `projection.test.ts`, `projection-steering.test.ts` and `sse-client.test.ts` guard these.
- **Trajectory fields** — `lib/trajectory-view-model.ts` holds label keys, badge classes and
  `drawerTabsFor`; a new drawer tab needs a `DrawerTabKey`, a `trajectory.json` key in both
  locales and a `TabBody` case in `TrajectoryDrawer.tsx`.
- **Diffs** — the generating side is the tools' `displayMetadata.fileChange` (core
  `FileChange`, `ConversationToolCall.fileChange`); the web side only aggregates
  (`collectTurnFileChanges`) and renders (`lib/diff-view.ts`). The cap is
  `MAX_TURN_FILE_DIFF_CHARS`; the tab identity that makes a repeated same-turn edit refresh
  instead of duplicate is `fileDiffTabId`.
- **Persistence** — a browser-stored preference is usually wrong: preferences belong to
  `GET/PUT /preferences` (`usePreferencesStore`), sidebar layout to `sidebar-state-api`;
  only device-local view state (widths, pane snapshots, current session id) belongs in
  `localStorage`.

Known rough edges, recorded rather than fixed: two Chinese list separators are hardcoded in
`TrajectoryDrawer` (`join('、')`, `join('；')`), the offline banner hardcodes
`http://localhost:3100` instead of the resolved base, `lib/sse-client.ts` exports a
singleton only its own test uses (real channels are created per session in `useChatAgent` /
`useSubagentChatAgent`), and several modules still carry Chinese comments
(`lib/projection.ts`, `lib/trajectory-view-model.ts`, `components/pane/SubagentTab.tsx`,
`stores/pane-store.ts`).

## Further reading (archive links)

- [Web trajectory view](../archive/superpowers/specs/2026-09-05-web-trajectory-view-design.md) — dual source and drawer tabs.
- [Right pane](../archive/superpowers/specs/2026-09-12-right-pane-design.md) — the tab platform and read-only browsing.
- [Agent todos](../archive/superpowers/specs/2026-09-15-agent-todos-design.md) — state as truth, re-injection each turn.
- [Background tasks](../archive/superpowers/specs/2026-09-15-web-background-tasks-design.md) — derivation and auto-open.
- [Clickable file links](../archive/superpowers/specs/2026-11-03-clickable-file-links-design.md) — surface-to-pane wiring.
- [Web i18n](../archive/superpowers/specs/2026-11-03-web-i18n-design.md) — `TextRef`, catalog split, audit script.
- [File ref annotations](../archive/superpowers/specs/2026-11-04-file-ref-annotations-design.md) — the annotation contract.
- [Steering queued messages](../archive/superpowers/specs/2026-11-04-web-steering-queued-messages-design.md) — queue semantics and D16.
- [Turn file diff](../archive/superpowers/specs/2026-11-06-turn-file-diff-design.md) — why tool-captured diffs beat git.
- [Archive index](../archive/INDEX.md) — every frozen spec and plan by date and module.
