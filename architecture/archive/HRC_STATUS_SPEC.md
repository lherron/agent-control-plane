# HRC_STATUS_SPEC

Spec for beefing up `hrc monitor show`. Validated against the codebase
(`packages/hrc-cli`, `packages/hrc-store-sqlite`, `packages/hrc-sdk`,
`packages/hrc-server`, `packages/hrc-events`, `packages/hrc-core`,
`packages/agent-scope`) so we only render data that already exists in state.

## Goals

1. Fix the `hrc monitor show --help` bug — currently prints status output instead of help.
2. Add `hrc monitor show <scopeRef>` that answers, in one screen, *"is this agent
   alive, blocked, or just busy?"*
3. Avoid fabricated/aspirational fields. If the schema does not back a field,
   it is not in v1.

## Bug fix: `hrc monitor show --help`

`cmdStatus` in `packages/hrc-cli/src/cli.ts:1295` runs the status request
unconditionally; the global `--help` check in `main()` only fires when `--help`
is the *command*, not a flag on a subcommand.

Fix:

- At the top of `cmdStatus`, short-circuit on `hasFlag(args, '--help')` /
  `hasFlag(args, '-h')` to print usage and return.
- Add a `printStatusUsage()` that mirrors the shape of `printEventsUsage()`
  (`cli.ts:995`).

## New: `hrc monitor show <scopeRef>`

### Scope resolution

Use `resolveScopeInput` from `packages/agent-scope/src/input.ts:24-60`
(same parser used by `cmdEvents` at `cli.ts:1121-1124`). **Do not** use
`resolveManagedScopeContext` — that auto-registers projects, which is wrong
for a read-only inspection command.

Accepted forms (same as `hrc monitor watch <scope>`):

- `<agentId>`
- `<agentId>@<projectId>`
- `<agentId>@<projectId>:<taskId>`
- with optional `~<lane>`

Project/task scopes include descendant role scopes via the existing
`matchesEventScopeSelection` / `ancestorScopeRefs` helpers
(`cli.ts:1154`).

### Output sections (in order, each conditional)

1. **Scope / Session** — host session id, active/archived, generation, lane.
2. **Runtime** — runtime id, harness, transport, status, `wrapperPid`,
   `childPid`, `last_activity` age, `activeRunId`. Plus a **liveness
   verdict**: `[LIVE]`, `[STALE]`, or `[EXITED]` (see Liveness below).
3. **Turn** — `IN PROGRESS` or `IDLE`. If in-progress: run id, launch id,
   age (now - turn.started.ts), tool-call count for the run, last tool name +
   age, and the user prompt that started the run (clipped).
4. **Continuation** — provider, key (truncated), `(stale)` if `continuationStale`.
5. **Surfaces** — bound surfaces (already in `/v1/status`,
   `hrc-server/src/index.ts:7370-7393`).
6. **Bridges** — only active local-bridge rows
   (`hrc-store-sqlite/src/repositories.ts:2315-2324`); skip if none. Pending /
   undelivered bridges are not modeled in state, so do not render.
7. **Last failure** — most recent failure-derived event in scope (see Failure
   derivation), capped at the last 50 events; `(none in last 50 events)`
   otherwise.
8. **Recent events** — compact one-line tail (default 10), no payloads.
9. **Next** — context-aware command hints (see Next-command hints).

### Sample output

```
Scope: clod@agent-spaces
Session:    hsid-b86ac758… (active) · gen 3 · lane main
Runtime:    rt-d6fbdec0… / claude-code / tmux / busy   [LIVE]
            wrapperPid 71107 · childPid 71109
            last_activity 2s ago · activeRunId run-9328aef4

Turn:       IN PROGRESS — run-9328aef4 · launch-04c9635f
            started 1m48s ago · 14 tool calls · last: Bash (3s ago)
            user prompt: "We need to beef up `hrc monitor show`."

Continuation: claude-code:sess-71ed… (fresh)
Surfaces:    ghostty:60F57AFE-… (bound)
Bridges:     (no active bridges)
Last failure: (none in last 50 events)

Recent events (10):
  16:46:57  turn.tool_call    Read
  16:46:57  turn.tool_result  exit=0
  ...

Next:
  hrc monitor watch clod@agent-spaces --from-seq 12345 --follow
  hrc runtime inspect rt-d6fbdec0…
  hrc attach clod@agent-spaces
```

### Flags

- `--json` — full structured output, no compact rendering.
- `--verbose` — include event payloads in the recent-events tail.
- `--events <n>` — change tail length (default 10, `0` to suppress section).

`--watch` is **out of scope for v1**.

### Runtime liveness

When the resolved session has an active runtime, the command performs a real
liveness probe rather than trusting the row's `status` field alone.

For each of `wrapperPid` and `childPid` (if present, per
`hrc-core/src/contracts.ts:236-237`):

- `process.kill(pid, 0)` — succeeds if alive, `ESRCH` if process is gone.

For tmux runtimes, additionally verify the pane still exists via
`tmux -S <hrc-tmux-socket> has-session -t <paneId>`.

Verdicts:

- `[LIVE]` — required pid(s) respond and (for tmux) the pane exists.
- `[STALE]` — row status is non-terminal (`ready`/`busy`) but a required pid
  is gone. Hints flip to recovery commands.
- `[EXITED]` — row is already terminal (`terminated`/`dead`).

### Turn detection

A turn is **IN PROGRESS** iff **all** of:

1. The runtime DTO from `inspectRuntime` has `activeRunId` set
   (`hrc-server/src/index.ts:3002-3030`).
2. For that `runId`, the latest event for the scope has kind in
   `{turn.accepted, turn.started, turn.user_prompt, turn.message,
   turn.tool_call, turn.tool_result}` and is **not** `turn.completed`.

Do **not** rely on `turn.stopped` — that is a hook-bridged event, not an HRC
lifecycle kind (`hrc-server/src/index.ts:8719-8758`).

Tool-call count = number of `turn.tool_call` events for the active `runId`.
Last tool = the most recent `turn.tool_call`'s tool name from payload.
Turn age = `now - ts(latest turn.accepted|started for runId)`.

### Failure derivation

There is no `category=error`. "Last failure" walks backward through the last
50 events in scope and returns the first match for any of:

- `turn.completed` with `payload.success === false` or `payload.errorCode` set
  (`hrc-server/src/index.ts:2221-2234`)
- `launch.exited` with non-zero `payload.exitCode`
  (`hrc-server/src/index.ts:4706-4718`)
- `launch.callback_rejected` (`hrc-server/src/index.ts:8428-8447`)
- `inflight.rejected` (`hrc-server/src/index.ts:5378`)
- `runtime.dead` (`hrc-server/src/hrc-event-helper.ts:27-57`)
- `turn.tool_result` with `payload.isError === true`
  (`hrc-events/src/hook-normalizer.ts:190-214`)

Render: `<ts> <eventKind> seq=<hrcSeq> — <one-line reason from payload>`.

### Next-command hints

Static set, picked by current state:

- Always: `hrc monitor watch <scope> --from-seq <N> --follow`
- If runtime present: `hrc runtime inspect <runtimeId>`
- If runtime tmux + LIVE: `hrc attach <scope>`
- If STALE: `hrc runtime sweep --status busy --scope <scope>`,
  `hrc runtime adopt <runtimeId>`
- If EXITED with continuation fresh: `hrc start <scope>` to relaunch.

### Data sources (validated)

- Sessions / surfaces — already aggregated by `getStatus`
  (`hrc-server/src/index.ts:7370-7393`).
- Runtime DTO — `client.inspectRuntime({ runtimeId })`
  (`hrc-server/src/index.ts:3002-3030`).
- Recent events for scope — local DB:
  `db.hrcEvents.listByScope(scopeRef, { limit: N })`
  (`hrc-store-sqlite/src/repositories.ts:2181`). Walk descendant scopes via
  `matchesEventScopeSelection`.
- Active local bridges — `hrc-store-sqlite/src/repositories.ts:2315-2324`.
- Continuation — already on the runtime DTO.

### What's deliberately **not** in v1

- Heartbeat / `last_seen` (no schema field; only `last_activity_at`).
- "Transport connected" boolean (not in DTO).
- Restart count (not modeled).
- Pending / undelivered bridges (events only, not state).
- `--watch` mode.
- Color coding.

## Tests

- `hrc monitor show --help` prints usage and exits 0; does not contact the daemon.
- `hrc monitor show` with no args behaves exactly as today (no regression).
- `hrc monitor show <scope>` with idle session prints `Turn: IDLE`.
- `hrc monitor show <scope>` with latest event `turn.started` for the active
  `runId` prints `IN PROGRESS` with correct duration + tool count.
- Liveness probe: synthetic runtime row with `wrapperPid` pointing to a dead
  PID is rendered `[STALE]`; live PID renders `[LIVE]`; terminal status
  renders `[EXITED]`.
- Failure derivation picks the closest matching event among the supported
  kinds; ignores non-failure events.
- `--json` shape is stable (snapshot test).
- Scope selector resolves identically to `hrc monitor watch <scope>` (shared
  `resolveScopeInput`).

## Implementation phases

1. **Phase A — bug fix + scaffolding.** Fix `--help` for `cmdStatus`. Add
   `printStatusUsage()`. Add scope-arg parsing branch in `cmdStatus` that
   stubs the new code path.
2. **Phase B — scoped read.** Implement section rendering for Scope / Session,
   Runtime (without liveness yet), Continuation, Surfaces, Bridges, Recent
   events. Reuses existing data sources.
3. **Phase C — turn detection + failure derivation.** Walk events,
   cross-check against `inspectRuntime.activeRunId`. Render Turn and Last
   failure sections.
4. **Phase D — liveness probe + recovery hints.** `kill -0` probes, tmux pane
   probe, hint set selection.
5. **Phase E — `--json` shape, `--verbose`, `--events <n>`.** Tests for all
   phases.

Each phase is a separate wrkq task and a separate commit. Phases B, C, D, E
can each be reviewed independently.

## Out of scope

- New schema fields (heartbeat, restart count, undelivered-bridge state).
  Those are real gaps but belong in their own design.
- A diagnostic / "doctor" command that recommends remediations beyond the
  static next-command hints. That can grow out of v1 once we see how people
  use it.
