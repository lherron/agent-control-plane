# Proposal: `acp task timeline --with-hrc` — Joined ACP+HRC view

**Status:** Proposal · awaiting cody implementation
**Author:** clod
**Date:** 2026-05-11
**Extends:** `specs/acp-task-timeline-cli.md`
**Constraint:** No new top-level CLI command. Extend existing `acp task timeline`.

---

## 1. Problem

`acp task timeline` shows the ACP workflow ledger only. HRC's runtime ledger (turn / tool / exec) is captured for every participant run but lives in a separate store. To see "what cody actually did inside this transition" you currently have to:

1. Read the `scope:` field on a `participant_run.launched` row.
2. Open `/Users/lherron/praesidium/var/state/hrc/state.sqlite`.
3. Hand-write a `SELECT … WHERE scope_ref = ?` joined to the launch/complete timestamps.

The data model already supports the join via `workflow_hrc_run_maps`. We just need to assemble it.

## 2. Goals

- Single command surface: `acp task timeline --with-hrc --task <id>` produces an interleaved ACP + HRC trace.
- ACP rows remain the spine; HRC rows are tributary, indented under the participant run that produced them.
- Stays within `acp task timeline` — no new subcommand.
- Read-only on the HRC store (operator may already have it open via `hrc events --follow`).
- Graceful degradation when no mapping or the HRC store is unreachable.

## 3. Non-goals

- Modifying the HRC store (read-only).
- Cross-task aggregation.
- Live tail (one-shot snapshot, like the rest of `task timeline`).
- Building a separate `acp task trace` command.

## 4. CLI surface — three new flags (HRC join is ON by default)

```
acp task timeline --task <id> [existing flags]
                  --no-hrc                    # opt-out; suppress HRC join entirely
                  --hrc-detail <mode>         # summary | events | full   (default: events)
                  --hrc-kinds <csv>           # filter HRC event_kind (e.g. tool_execution_start,tool_execution_end)
                  --hrc-store <path>          # override; default: $HRC_STATE_DIR/state.sqlite
                                              #          fallback: /Users/lherron/praesidium/var/state/hrc/state.sqlite
```

The HRC join is enabled by default whenever the task has at least one
`workflow_hrc_run_maps` row and the HRC store is reachable. `--no-hrc` is the
escape hatch (e.g. for piping into a script that only wants ACP rows, or when
the HRC store is on a remote host and you want a fast read).

When `--no-hrc` is set, the other HRC flags are ignored. When the HRC store is
unreachable, the renderer prints a one-line warning in the header and falls
through to ACP-only output (same as if `--no-hrc` were set) — never errors.

**Compatibility note:** this is a behavior change from the v1 timeline (which
was ACP-only). For a purely ACP rendering, callers and golden-file tests must
add `--no-hrc`. The v1 golden file should be re-recorded under `--no-hrc` and a
new golden file added for the default (joined) output.

`--hrc-detail`:
- `summary` — one row per participant run: `└─ hrc/N events  (5 turns, 12 tool calls)`
- `events` (default) — one row per HRC event, kind + short label
- `full` — events + payload preview (one truncated line per event)

## 5. UX mockups — emulate the Discord gateway tool-line model

The Discord gateway already has a polished, battle-tested tool-rendering model
in `packages/gateway-discord/src/render.ts`. We adopt it verbatim and extract
the primitives into a shared package so the timeline and Discord render the
same line for the same tool call.

### 5.0 Primitives lifted from gateway-discord

```ts
// per-tool emoji
const TOOL_EMOJI = {
  Bash: '💻', Read: '📖', Write: '✍️', Edit: '🔧',
  Grep: '🔎', Glob: '📁', Task: '🤖',
  WebFetch: '📄', WebSearch: '🔍', TodoWrite: '📋', NotebookEdit: '📓',
}
const DEFAULT_TOOL_EMOJI = '⚙️'

// "what's the most useful one-string preview for this tool?"
const PRIMARY_ARG_KEY = {
  Bash: 'command', Read: 'file_path', Write: 'file_path', Edit: 'file_path',
  Grep: 'pattern', Glob: 'pattern', Task: 'description',
  WebFetch: 'url', WebSearch: 'query', NotebookEdit: 'notebook_path',
}

const NOTICE_ICON = { info: 'ℹ️', warn: '⚠️', error: '❌' }
const MAX_LINE_CHARS = 80
const MAX_PREVIEW_CHARS = 60
```

Format rule (verbatim from Discord): `<emoji> <toolName>: "<preview>"`, where
preview comes from the primary arg, falls back to first string-valued arg,
gets truncated with `…` to the budget. Failed tools render `❌` instead of the
tool emoji. `TodoWrite` shows `<N> todos`.

### 5.1 Default (HRC join on, events depth) — Discord-style tool lines

```
  ●  acp/4   05:30:57  transition.applied red→green        cody/implementer  v0→v1
  ▶  acp/5   05:31:32  participant_run.launched prun_0888  cody              scope: agent:cody:project:agent-spaces
     ├─ hrc/12471  05:31:33  💬 user_prompt           "you are the implementer for ACP task hl-mvp-002909…"
     ├─ hrc/12473  05:31:34  💻 Bash:                 "ls -la /tmp"
     ├─ hrc/12480  05:31:35  💻 Bash:                 exit=0  (12ms)
     ├─ hrc/12482  05:31:35  📖 Read:                 "/Users/lherron/praesidium/agent-spaces/HEURISTI…"
     ├─ hrc/12489  05:31:36  🔧 Edit:                 "packages/acp-cli/src/commands/task-timeline.ts"
     └─ hrc/12492  05:31:37  ✉️  message_end
  ◆  acp/6   05:31:32  hrc_run.mapped hrcrun-postfix-1     cody              scope: agent:cody:project:agent-spaces
  ●  acp/7   05:31:55  evidence.attached qa_bundle         cody/implementer
```

Each HRC tool line uses Discord's exact `<emoji> <toolName>: "<preview>"` format. `tool_execution_start` and `tool_execution_end` pair into "request" and "result" lines under the same emoji. Non-tool HRC kinds get their own minimal mapping (`💬` for user_prompt, `🤖` for assistant message, `✉️` for message_end, `ℹ️` for notice, `⚠️`/`❌` for warn/error). See §5.7 for the full HRC-kind icon table.

Indented HRC block uses `├─` for inner rows and `└─` for the last; box-drawing characters consistent with the existing boxed header. ASCII fallback under `--plain`:

```
  [+] acp/4   05:30:57  transition.applied red->green        cody/implementer  v0->v1
  [>] acp/5   05:31:32  participant_run.launched prun_0888   cody
        hrc/12471  05:31:33  codex.user_prompt
        hrc/12473  05:31:34  tool_execution_start  Bash
        hrc/12480  05:31:35  tool_execution_end    Bash exit=0
        hrc/12482  05:31:35  codex.tool_result     Bash
        hrc/12489  05:31:36  message_update
        hrc/12492  05:31:37  message_end
```

### 5.2 `--hrc-detail summary`

```
  ▶  acp/5   05:31:32  participant_run.launched prun_0888   cody
     └─ hrc: 6 events (1 user_prompt, 2 tool_call pairs, 3 messages)  range hrc/12471..12492
```

One folded line. Useful for long runs where event-by-event would dominate the view.

### 5.3 `--hrc-detail full`

```
     ├─ hrc/12473  05:31:34  tool_execution_start  Bash
                              cmd: ls -la /tmp
     ├─ hrc/12480  05:31:35  tool_execution_end    Bash exit=0
                              stdout: total 48\ndrwxrwxrwt …
                              duration: 12ms
```

Per-event payload preview, indented two more steps. Truncated to one line per field with `…`.

### 5.5 End-of-turn assistant message — render as markdown

The assistant's final turn response (the `message_end` HRC event's content, or
the accumulated `message_update`/`sdk.message` body if `message_end` is missing)
gets a dedicated render that **preserves markdown structure** instead of the
80-char one-line preview that tool rows use.

```
     ├─ hrc/4445542  05:35:42  💻 exec_command:  "ls -la /tmp"
     ├─ hrc/4445543  05:35:42  💻 exec_command:  exit=0  (12ms)
     └─ hrc/4445999  05:36:00  🤖 assistant
        ┌─
        │ Implementer evidence attached. Summary:
        │
        │ - **Repro:** stale-context rejection at task version 0
        │ - **Fix:** none — this is the pre-fix red phase
        │ - **Next:** await supervisor for red→green
        │
        │ ```bash
        │ acp task evidence add --task hl-mvp-002909 --kind tdd_green_bundle …
        │ ```
        └─
```

Rules:
- Triggered by `message_end` or, if absent, the last `message_update` /
  `sdk.message` of the run.
- Content is wrapped in a left-bar block (`│` on TTY, `> ` indent under
  `--plain`, blockquote `>` under `--markdown`).
- **Inline markdown is preserved verbatim** — fenced code blocks, lists,
  headings, links — and rendered with terminal styling when on a TTY:
  - `**bold**` → `chalk.bold`
  - `*italic*` → `chalk.italic`
  - `` `code` `` → `chalk.cyan` (or just preserved chars under `--plain`)
  - Fenced ``` ``` ``` blocks → dim background, no syntax highlighting
    (avoid pulling a heavyweight TUI markdown lib; the rest of the line is
    monospace anyway)
  - Headings `# `/`## ` → `chalk.bold` + underline
  - Bullet `- ` → `chalk.dim('•')` prefix
- Width: wrap to `--width` minus the indent. Long lines wrap with hanging
  indent inside the bar.
- Truncation: cap rendered body at **40 lines** (`--hrc-detail events`) or
  **120 lines** (`--hrc-detail full`); show `… <N> more lines` at the bottom
  if elided. `summary` mode drops the body entirely and shows
  `🤖 assistant  <first-80-chars>…`.
- One assistant block per run by default; if multiple turn-ends exist in
  one participant run (rare), render each chronologically.
- `--json`: include the full body in the row payload (no truncation, no
  styling); the renderer alone applies the bar/wrap/truncate.

Suggested helper to extract into `agent-action-render`:
```ts
export function renderMarkdownBlock(
  body: string,
  opts: { width: number; maxLines: number; style: 'tty' | 'plain' | 'markdown' }
): string[]   // returns lines, caller adds the indent/bar
```

This keeps the rule reusable for any future surface that wants to embed an
assistant turn (Discord, web ops dashboard, etc.).

### 5.6 Repeating-tool-call collapse

When the same tool name appears in **more than three consecutive HRC tool rows**
(any consecutive `tool_execution_start`/`tool_execution_end`/`codex.tool_result`
rows whose tool name is identical), render the first three and collapse the
remainder into one summary line.

```
     ├─ hrc/4445542  05:35:42  💻 exec_command:  "ls -la /tmp"
     ├─ hrc/4445543  05:35:42  💻 exec_command:  exit=0  (12ms)
     ├─ hrc/4445777  05:35:50  💻 exec_command:  "head -n 50 /etc/hosts"
     └─ … 17 more exec_command calls
     ├─ hrc/4446001  05:36:02  📖 Read:          "/Users/lherron/.../foo.ts"
```

Rules:
- "Repeating" means **same tool name** (lookup key after extracting from
  payload, e.g. `exec_command`, `apply_patch`, `Bash`, `Read`).
- Counts the entire run; the displayed first-three are picked from the
  beginning of the run, not sampled.
- The collapse line uses `…` (ellipsis) and shows `<count> more <toolName>
  calls` (singular when count==1).
- Applies in `--hrc-detail events` mode only. `summary` already collapses
  everything; `full` shows everything (no collapse — operator opted in to
  verbosity).
- The 500-event cap from §8.4 still applies on top of this; collapse runs
  first, then cap.
- In `--json` output, return the raw stream (no collapse) — the renderer
  alone applies it. Add `collapsedRuns: [{ start, end, count, toolName }]` to
  the response if any collapse fired, so callers can re-collapse if they
  pretty-print.

### 5.7 HRC kind → icon table (single source of truth)

This lives in the shared package; both Discord and the timeline consume it.

| HRC `event_kind`               | Icon | Notes                                                    |
|--------------------------------|------|----------------------------------------------------------|
| `tool_execution_start`         | per-tool emoji from `TOOL_EMOJI` | preview = primary arg                       |
| `tool_execution_end`           | same emoji (or `❌` if failed)   | preview = `exit=N (Xms)`                    |
| `codex.tool_decision`          | `⚖️`  | preview = decision summary                              |
| `codex.tool_result`            | same as the matching call (deduped under it) | suppressed in `events`, kept in `full` |
| `codex.user_prompt`            | `💬` | preview = first 60 chars                                 |
| `sdk.message` / `message_*`    | `🤖` | preview = first 60 chars of content                      |
| `message_end`                  | `✉️` | preview = empty                                          |
| `hook.ingested`                | `🪝` | preview = hook name                                      |
| `notice` (level=info)          | `ℹ️` | preview = message                                        |
| `notice` (level=warn)          | `⚠️` | preview = message                                        |
| `notice` (level=error)         | `❌` | preview = message                                        |
| `runtime.dead`                 | `💀` | preview = exit code / reason                             |
| anything else                  | `⚙️` | preview = first string-valued field of payload           |

### 5.4 `--hrc-kinds tool_execution_start,tool_execution_end`

```
  ▶  acp/5   05:31:32  participant_run.launched prun_0888   cody
     ├─ hrc/12473  05:31:34  tool_execution_start  Bash
     └─ hrc/12480  05:31:35  tool_execution_end    Bash exit=0
```

Other HRC kinds suppressed for that block; ACP rows unchanged.

### 5.5 No HRC mapping or store unreachable

Header gains a one-line warning, ACP rows render unchanged, no HRC blocks:

```
┌─ Task hl-mvp-002909 ─────────────────────────────────────────────────────────┐
│ Workflow: code_defect_fastlane@1                                             │
│ Status: closed   Outcome: completed                                          │
│ ⚠ HRC store at /Users/lherron/praesidium/var/state/hrc/state.sqlite          │
│   is unreachable; rendering ACP-only.                                        │
└──────────────────────────────────────────────────────────────────────────────┘
```

Or, when reachable but no mapping exists for any participant run:

```
│ ⚠ No workflow_hrc_run_maps rows for this task; rendering ACP-only.           │
```

Per-participant-run, when only some runs lack mappings, the ones with mappings show their HRC blocks; the others show `└─ hrc: no mapping` as a one-line marker.

## 6.0 Anchor selection — what an HRC block hangs off

### 6.0.1 Default: hybrid `auto` anchor

The renderer chooses the join anchor per task:

- **Task has at least one `participant_run.launched`:** anchor on each
  participant run (current behavior — see §6.1).
- **Task has zero `participant_run.launched`:** anchor on each
  *actor-bearing ACP event* (`task.created`, `evidence.attached`,
  `transition.applied`, `transition.rejected`, etc.). For each such event:
  - `scope_ref = "agent:<actor.id>:project:<task.projectId>"`
  - window = `[event.ts − 5s, event.ts + 30s]` (tight; the agent session
    activity that bracketed *this specific command*)
  - render the resulting HRC events as a child block under the ACP event
    row, same indent/icon rules as run-anchored blocks
  - apply the same default exclude list, kind filters, and 500-event cap

This matters for tasks like `hl-pb-sod2-003942` which were driven through
direct CLI calls or DMs rather than via `acp task run`. Today they appear
empty even though the agent session has full HRC activity around each
command.

### 6.0.2 Explicit override: `--hrc-anchor`

```
--hrc-anchor runs|events|both|auto      (default: auto)
```

- `runs` — current behavior; anchor only on `participant_run.launched`.
  No HRC blocks for tasks without runs.
- `events` — anchor only on actor-bearing ACP events; ignore participant runs.
  Useful when supervisor actions happen *outside* a participant run window
  but you still want their HRC context.
- `both` — anchor on both. Run-anchored blocks group long-lived activity;
  event-anchored blocks fill in gaps. Could double-count; the renderer
  dedupes by `(scope_ref, hrc_seq)`.
- `auto` (default) — `runs` if the task has any, else `events`.

### 6.0.3 Window tunable

```
--hrc-event-window <seconds>            (default: 30)
```

Per-event window radius for the `events` / `both` / `auto-fallback` modes.
Useful when an evidence attach was preceded by a long agent thinking burst
that you want included.

## 6. Join semantics (per-anchor mechanics)

For each ACP `participant_run.launched` event with `participantRunId = P`:

1. Look up the matching `workflow_hrc_run_maps` row for `P`.
2. **Primary join (precise):** if `map.hrcRunId` matches `events.run_id` for at least one row, use:
   ```sql
   SELECT seq, ts, event_kind, event_json
     FROM events
     WHERE run_id = :hrcRunId
       AND ts >= :launchTs
       AND ts <= COALESCE(:completeTs, datetime('now'))
     ORDER BY seq ASC
   ```
3. **Fallback join (scope+window):** if (2) returns zero rows (synthetic mapping, mapping written before launch identity was known, etc.), use:
   ```sql
   SELECT seq, ts, event_kind, event_json
     FROM events
     WHERE scope_ref = :scopeRef
       AND lane_ref  = COALESCE(:laneRef, 'main')
       AND ts >= :launchTs
       AND ts <= COALESCE(:completeTs, datetime('now'))
     ORDER BY seq ASC
   ```
   Annotate the block header so the user knows it's the loose join: `└─ hrc (scope+window join, N events)`.

The `:completeTs` comes from the matching `participant_run.completed` ACP event; if none exists, bound at `now`.

## 7. Data model

Reuse the existing `TimelineRow`. Add an HRC variant:

```ts
type HrcChildRow = {
  ledger: 'hrc'
  parentParticipantRunId: string
  hrcSeq: number
  ts: string
  eventKind: string
  label?: string                   // short, e.g. tool name + exit
  payload?: Record<string, unknown> // for --hrc-detail full
}

type TimelineRow =
  | (ExistingAcpRow & { ledger: 'acp' })
  | HrcChildRow
```

Renderer walks ACP rows in order; when it hits a `participant_run.launched` row, it inserts the HRC children for that run immediately after, indented.

## 8. Implementation notes

### 8.1 New shared package — extract Discord's renderers

Create `packages/agent-action-render` (or fold into `cli-kit`) containing the
zero-dependency primitives. Both `gateway-discord` and `acp-cli` consume it.

```
packages/agent-action-render/
  src/
    tool-formatters.ts     # TOOL_EMOJI, PRIMARY_ARG_KEY, formatToolLine,
                           # extractToolPreview, getToolEmoji
    notice-formatters.ts   # NOTICE_ICON, formatNoticeLine
    hrc-kind-icons.ts      # NEW: HRC event_kind → icon mapping (see §5.7)
    budgets.ts             # MAX_LINE_CHARS, MAX_PREVIEW_CHARS, truncation helper
    index.ts
  package.json             # zero runtime deps
  src/__tests__/
```

`packages/gateway-discord/src/render.ts` removes its local copies of
`TOOL_EMOJI`, `PRIMARY_ARG_KEY`, `NOTICE_ICON`, `MAX_LINE_CHARS`,
`MAX_PREVIEW_CHARS`, `getToolEmoji`, `formatToolLine`, `extractToolPreview`,
`formatNoticeLine` and re-exports them from `agent-action-render`. Discord
behavior is byte-identical (existing render tests are the regression net).

### 8.2 New files in acp-cli

- `packages/acp-cli/src/output/timeline-hrc-join.ts` — pure: takes ACP rows + map list + HRC events, returns interleaved `TimelineRow[]`. Calls into `agent-action-render` for line formatting.
- `packages/acp-cli/src/output/hrc-event-to-row.ts` — pure: maps an HRC event row to a `TimelineRow` using the icon table from §5.7 and Discord's `formatToolLine` for tool kinds.
- `packages/acp-cli/src/hrc-store-reader.ts` — opens `state.sqlite` read-only (`new Database(path, { readonly: true })`), exposes `fetchHrcEventsForRun({ scopeRef, laneRef, hrcRunId, fromTs, toTs })`.
- Tests:
  - `__tests__/timeline-hrc-join.test.ts` (unit)
  - `__tests__/hrc-event-to-row.test.ts` (golden lines per HRC kind)
  - `__tests__/hrc-store-reader.test.ts` (uses a tmp sqlite with seed rows)
  - `test/commands/task-timeline-with-hrc.test.ts` (integration via CLI runner)

### 8.2 Updates

- `packages/acp-cli/src/commands/task-timeline.ts` — wire flags, call joiner unless `--no-hrc`, render warnings on missing store/mapping.
- `packages/acp-cli/src/output/timeline-render.ts` — add HRC indent renderer (box-drawing on TTY, plain spaces under `--plain`, `> ` under `--markdown`).
- Existing tests that asserted ACP-only output: re-record under `--no-hrc` and add new goldens for the joined default.

### 8.3 Path resolution

```ts
const hrcStorePath =
  flags.hrcStore ??
  (process.env.HRC_STATE_DIR
    ? join(process.env.HRC_STATE_DIR, 'state.sqlite')
    : '/Users/lherron/praesidium/var/state/hrc/state.sqlite')
```

If file doesn't exist or `Database()` throws, print the warning header and fall through to ACP-only rendering. Never error the whole command.

### 8.4 Performance

- One HRC SQLite query per participant run (typical task has 1–3). Each query bounded by ts window so it's a small range scan on `(scope_ref, ts)` or `(run_id, ts)` — both indexed paths.
- For `--hrc-detail summary`, only run `COUNT(*) GROUP BY event_kind`; no payload reads.
- Cap per-block at 500 events; if exceeded, render the first 250 + `(N events elided — use --hrc-detail summary)` + last 100.

### 8.5 Markdown output

`--markdown --with-hrc` should produce nested rows under the participant run row using indented bullet lists, not a second table:

```markdown
| 5 | 05:31:32 | ▶️ participant_run.launched prun_0888 | cody | scope: agent:cody:project:agent-spaces |
- hrc/12471  05:31:33  codex.user_prompt
- hrc/12473  05:31:34  tool_execution_start  Bash
- hrc/12480  05:31:35  tool_execution_end    Bash exit=0
| 6 | 05:31:32 | ◆ hrc_run.mapped hrcrun-postfix-1 | cody | … |
```

(Tables don't nest cleanly in markdown; bullet break is the pragmatic choice.)

### 8.6 JSON output

`--json` (joined by default) returns the unified row stream:

```json
{
  "task": { … },
  "rows": [
    { "ledger": "acp", "seq": 4, … },
    { "ledger": "acp", "seq": 5, "type": "participant_run.launched", … },
    { "ledger": "hrc", "parentParticipantRunId": "prun_0888", "hrcSeq": 12471, … },
    { "ledger": "hrc", "parentParticipantRunId": "prun_0888", "hrcSeq": 12473, … },
    { "ledger": "acp", "seq": 6, … }
  ],
  "warnings": [ "hrc_join_fallback:prun_0883:scope+window" ]
}
```

## 9. Acceptance criteria

- `acp task timeline --task hl-mvp-002909 --plain` renders ACP rows interleaved with HRC events under each `participant_run.launched` **by default** (no flag required).
- `acp task timeline --task hl-mvp-002909 --plain --no-hrc` produces the v1 ACP-only output (re-recorded golden).
- For our synthetic smoke mappings (where `hrcRunId` doesn't match any HRC `run_id`), the renderer falls back to the scope+window join and labels the block.
- `--hrc-detail summary` collapses each block to a single line with counts.
- `--hrc-detail full` adds payload preview lines.
- `--hrc-kinds <csv>` filters which HRC kinds are shown.
- Missing/unreachable HRC store: warning in header, no error, ACP-only render (same shape as `--no-hrc`).
- `--json` (no flag needed) returns interleaved `rows` with `ledger` discriminator and a `warnings` array.
- `--no-color`, `--plain`, `--markdown` all work with the joined default and with `--no-hrc`.

## 10. Out of scope

- HRC event aggregation across tasks.
- Editing or pruning HRC events.
- Tailing the joined view.
- Cross-runtime correlation (multiple HRC instances).

## 11. Open questions

1. Default `--hrc-detail`: `events` is information-dense but can be overwhelming on long runs. My lean: keep `events` as the implicit default, count-cap at 500 with the elision marker.
2. Should `--hrc-kinds` accept negation (`--hrc-kinds '!codex.websocket_event'`) to suppress noisy classes? Useful but adds parsing complexity. Could ship without and add later.
3. Should the renderer dedupe back-to-back `tool_execution_start`+`tool_execution_end` into a single `tool_call Bash 12ms` row in `events` mode? Cleaner but loses the exact seqs. Lean: keep both, dedupe only in `summary` mode.
4. Default `--hrc-kinds` filter: with HRC join on by default and `codex.websocket_event` accounting for >95% of events on a busy session, raw default output could be 1000s of lines per participant run. Lean: ship with a built-in exclude list `['codex.websocket_event','codex.sse_event','codex.websocket_request','codex.websocket_connect']` and a `--hrc-all-kinds` escape.
5. Where should `agent-action-render` live? My lean: standalone package, zero deps. Alternative: fold into `cli-kit`. Pick whichever you prefer — the migration of `gateway-discord/src/render.ts`'s primitives is the same either way.
