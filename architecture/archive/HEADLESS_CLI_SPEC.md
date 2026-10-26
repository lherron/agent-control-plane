# HEADLESS_CLI_SPEC

Proposal to extend `hrc` CLI so operators can inspect and clean up headless
runtimes without dropping into SQL. Written 2026-04-24 as the follow-up to
T-01216 (silent-success headless turns + stale-generation auto-rotation).

Owner: TBD. Pick up in a fresh session.

## 1. Motivation

Today's `hrc runtime` surface is tmux-shaped. It assumes every runtime has a
pane you can attach to, kill, or send keys to. Headless agent-sdk runtimes
don't have panes — they spawn a Claude/Codex child per turn and rely on the
HRC DB for bookkeeping — so every tmux-shaped verb either rejects them or
leaves them stuck.

Concrete gaps surfaced by the 2026-04-24 incident (curly@media-ingest:T-01213,
rt-3b0b77d0 wedged for 2+ hours):

- `hrc runtime terminate <id>` throws `runtime "<id>" is missing tmux state`
  before finalizing termination. Error originates in
  `packages/hrc-server/src/index.ts:8336` (`requireTmuxPane` called by
  `terminateRuntime` at `:3682-3684`). Same class of bug in `handleInterrupt`
  and `handleCapture`.
- `hrc runtime list` has no filter for transport/status/age, so finding
  stale headless records means hand-written SQL.
- There is no bulk/sweep operation. A wedged runtime whose child has already
  exited is invisible to the CLI unless the operator knows its runtimeId.
- `hrc runtime adopt` is defined for tmux-only (its purpose is re-attaching
  to an abandoned pane) and has no headless meaning.
- No CLI verb exists to drop a stale `continuation_json` without also
  rotating generation. (T-01216's auto-rotation handles this lazily per
  DM, but operators need an imperative path too.)

Stale-generation auto-rotation (landed in T-01216) mostly sidesteps the
dispatch-time symptom by bumping the session generation before the next
turn. It does NOT clean up the runtime records themselves — they remain in
the DB with `status='ready'` or `status='busy'` forever, cluttering `runtime
list` output and breaking scripts that iterate runtimes.

## 2. Proposed CLI surface

### 2.1 Fix existing verbs for headless

- `hrc runtime terminate <id>` — branch on `runtime.transport`.
  - `'tmux'` → current behavior (inspect, kill session, finalize).
  - `'headless'` → skip tmux, finalize DB record, emit
    `runtime.terminated` HRC event with `transport: 'headless'`, optional
    `--drop-continuation` flag to also clear `continuation_json` on the
    session.
  - `'sdk'` → same as headless for now (no pane).
- `hrc runtime interrupt <id>` — same branching. For headless with an
  active run, set `runs.status='cancelled'`, clear `active_run_id` on the
  runtime, emit `runtime.interrupted`. For no active run, no-op with a
  warning.
- `hrc runtime capture <id>` — refuse cleanly for headless with a message
  pointing at the event stream instead of the tmux pane.
- `hrc runtime adopt <id>` — refuse for headless (`adopt` is a
  tmux-specific concept; there's nothing to re-attach to).

### 2.2 New flags on `hrc runtime list`

```
hrc runtime list
  [--host-session-id <id>]
  [--scope <agent:…>]              # filter by scope_ref prefix match
  [--transport <tmux|headless|sdk>]
  [--status <status>[,<status>…]]  # comma-list: ready,busy,terminated,dead
  [--stale [--older-than <dur>]]   # shorthand for status IN ('ready','busy')
                                   # AND created_at < now - <dur>; default 24h
  [--json]
```

`--stale` without `--older-than` uses the server's
`HRC_STALE_GENERATION_HOURS` (default 24h) so the same threshold governs
both auto-rotation and operator inspection.

### 2.3 New verb: `hrc runtime sweep`

```
hrc runtime sweep
  [--transport <tmux|headless|sdk>]       # required for tmux (blast radius)
  [--older-than <dur>]                    # default 24h
  [--status <list>]                       # default: ready,busy
  [--scope <prefix>]
  [--drop-continuation]                   # also null the session's continuation_json
  [--dry-run]                             # default when TTY; --yes to apply
  [--yes]                                 # required when non-TTY
  [--json]
```

Matches runtime records and terminates each one, same code path as
`terminate <id>`. Emits one `runtime.terminated` event per match, plus a
single `runtime.sweep_completed` summary event with counts. Output is
either a table (TTY) or a newline-delimited JSON stream (`--json`).

Default safety: `--dry-run` is implied when stdout is a TTY and neither
`--dry-run` nor `--yes` was passed. When piped/scripted, `--yes` is
required to mutate. `--transport tmux` rejects without an explicit
`--yes` because terminating tmux runtimes is destructive to interactive
sessions.

### 2.4 New verb: `hrc runtime inspect <id>`

Enriches today's `runtime list` detail:

```
runtime rt-3b0b77d0-…
  scope         agent:curly:project:media-ingest:task:T-01213
  lane          main
  generation    2
  transport     headless
  harness       claude-code
  provider      anthropic
  status        busy
  createdAt     2026-04-20T03:58:23Z  (age: 4d 6h)
  lastActivity  2026-04-24T15:53:07Z  (age: 1h 27m)
  activeRunId   run-fc5fefa3-…
  wrapperPid    — (headless; no wrapper)
  childPid      — (headless; spawned per turn)
  continuation  anthropic:sdk-9d12a8d8… (note: older than threshold, will
                auto-rotate on next dispatch)
```

Pure read; no flags beyond `--json`.

### 2.5 New verb: `hrc session drop-continuation <hostSessionId>`

Imperative counterpart to auto-rotation's `dropContinuation: true`.
Useful when the operator knows a continuation is corrupted but doesn't
want to rotate the generation (e.g. to preserve prior_host_session_id
chains for forensics).

```
hrc session drop-continuation <hostSessionId> [--reason <text>]
```

Emits `session.continuation_dropped` with reason in payload. No generation
bump.

### 2.6 Optional: `hrc runtime purge-terminated`

One-shot DB housekeeping — delete (not update) runtime rows with
`status='terminated'` older than N days. Separate from `sweep` because it
deletes rather than transitions state. Low priority; defer until
`sweep`'s terminated rows become a real clutter problem.

## 3. Implementation notes

### 3.1 Server changes

- `packages/hrc-server/src/index.ts`
  - Factor `terminateRuntime` into two private methods:
    - `terminateTmuxRuntime(runtime)` — current body.
    - `terminateHeadlessRuntime(runtime, opts)` — skip tmux; optionally
      clear session continuation; finalize; emit event.
    - `terminateRuntime(runtime, opts)` → dispatcher.
  - Similarly split `handleInterrupt` / `handleCapture`.
  - New handler `handleSweep(request)` — parses filter spec, iterates
    matching runtimes, calls the per-runtime terminate helper, streams
    event ids back. Use NDJSON response for large sweeps.
  - New handler `handleDropContinuation(request)` at
    `POST /v1/sessions/:hostSessionId/drop-continuation`.
- `packages/hrc-core/src/http-contracts.ts`
  - Add `TerminateRuntimeRequest` with `dropContinuation?: boolean`.
  - Add `SweepRuntimesRequest` / `SweepRuntimesResponse`.
  - Add `DropContinuationRequest` / `DropContinuationResponse`.
- `packages/hrc-server/src/hrc-event-helper.ts`
  - `KIND_CATEGORIES` gains `runtime.sweep_completed`,
    `session.continuation_dropped`.

### 3.2 CLI changes

- `packages/hrc-cli/src/cli.ts`
  - `cmdTerminate`: accept `--drop-continuation` flag.
  - `cmdRuntimeList`: accept `--transport`, `--status`, `--stale`,
    `--older-than`, `--scope`, `--json`.
  - New `cmdRuntimeSweep` and `cmdRuntimeInspect`.
  - New `cmdSessionDropContinuation`.
  - Update help text + `INFO_TEXT`.

### 3.3 Tests

- Unit: new repo-level test (`packages/hrc-server/src/__tests__/
  runtime-terminate-headless.test.ts`) covering each transport branch
  plus the `--drop-continuation` variant.
- Integration: extend `stale-generation-auto-rotate.test.ts` with a sweep
  scenario (seed 3 stale headless runtimes, sweep, assert all
  terminated and events emitted).
- CLI snapshot tests for list/sweep output formatting.

## 4. Open questions

1. **Sweep idempotency on races** — if two operators sweep simultaneously,
   the second shouldn't error out per-runtime. Use `UPDATE … WHERE
   status IN ('ready','busy')` guard so already-terminated rows are
   skipped silently. Needs `HrcConflictError` → benign skip at the
   handler level.
2. **Should sweep rotate session generations too?** Argument for: many
   operators will want "nuke everything stale and start clean" in one
   command. Argument against: mixing runtime termination and session
   rotation in one verb is a scope-creep trap. Current proposal: no,
   keep them separate. Rotation already happens lazily on next
   dispatch.
3. **Does `interrupt` make sense for agent-sdk runtimes that aren't
   currently mid-turn?** The in-process SDK transport has `interrupt()`
   but no concept of "pending next turn to cancel" between turns.
   Propose: no-op with warning when `active_run_id` is null.
4. **Default `--older-than` value** — reuse
   `HRC_STALE_GENERATION_HOURS`? Or a separate
   `HRC_SWEEP_DEFAULT_HOURS`? Reusing is simpler; operators who want
   different thresholds can pass explicit values.
5. **Does `terminate` without `--drop-continuation` leave the session's
   continuation pointing at a dead native SDK session?** Yes, and
   that's intentional for tmux today (continuation is meaningful across
   runtime restarts). For headless, the argument cuts the other way:
   terminating a headless runtime usually implies the continuation is
   also suspect. Propose defaulting `--drop-continuation=true` when
   `transport='headless' && status='busy'`, false otherwise.
6. **Should `hrc runtime adopt` grow a meaningful headless semantic,
   or stay tmux-only?** Keep tmux-only. Adopting a headless runtime
   has no referent — there's no child process to re-attach to.

## 5. Current status of related work (as of 2026-04-24 17:35)

### Landed

- `fix/silent-headless-turn-success` branch, commits `4e62b66` and
  `99f4f1b`.
- `4e62b66` — agent-sdk silent-success guard (`empty_response`),
  stop-tolerance for dead child, structured logging, 6 new tests
  (`packages/agent-spaces/src/__tests__/headless-empty-response.test.ts`).
- `99f4f1b` — stale-generation auto-rotation feature plus the user's
  WIP restored from stash. New contract fields
  `allowStaleGeneration?: boolean` on EnsureRuntimeRequest,
  StartRuntimeRequest, DispatchTurnRequest, SemanticDmRequest. New
  env-driven config `HRC_STALE_GENERATION_HOURS` (default 24h),
  `HRC_STALE_GENERATION_ENABLED` (default true). 5 new tests
  (`packages/hrc-server/src/__tests__/stale-generation-auto-rotate.test.ts`).
- HRC restarted at 17:26:34 to pick up the new code; headless DM probe
  to smokey verified round-trip; both probed sessions (smokey gen 1→2,
  clod gen 2→3) auto-rotated via the `semantic-dm` trigger as expected.

### Pending on T-01216 (not yet done)

- **Headless branch in `terminateRuntime`** — ~15-line patch, offered
  to clod@media-ingest in DM #528, awaiting confirmation before
  bundling on the same branch. This is the minimum fix that unblocks
  the immediate rt-3b0b77d0 case without the full CLI surface in this
  spec.
- **HRC-side runtime cleanup on agent-sdk child exit** — when the SDK
  child exits non-zero, the HRC runtime record should transition to
  `terminated` automatically. Currently T-01216 only prevents the
  silent-success symptom at the dispatch boundary; the orphaned
  runtime record itself is still cleaned up lazily by auto-rotation.
  Tracked as a deferred item on the task.
- **hrcchat DM prompt-shape change** ("pass message ID vs. full body
  as CLI arg") — evaluated and deferred; orthogonal to the silent-
  success bug and a significant design change. Not in scope for
  T-01216.

### Known stale state still in the DB (pre-existing, not cleaned)

- `rt-18b61497-2acb-44dd-af3e-8b71befca54d` (clod@agent-spaces,
  headless, agent-sdk) — created 2026-04-20, last touched 2026-04-24
  16:00 via the silent-success turn that motivated T-01216. Auto-
  rotation has bypassed it but the record is still `status='ready'`.
- `rt-3b0b77d0-…` (curly@media-ingest:T-01213, headless) — the
  incident runtime from clod@media-ingest's DM #522. Still
  `status='busy'`. Would be cleaned by either the terminateRuntime
  headless fix or the proposed `hrc runtime sweep`.
- General sweep recommended post-land: terminate all
  `transport='headless'` rows with
  `status IN ('ready','busy') AND created_at < now() - 24h`.

### Workspace test status

- Relevant packages (hrc-core, hrc-server, agent-spaces,
  harness-claude): 586 pass, 0 fail.
- Pre-existing fails on main: 8 tests in `runtime lifecycle
  start/attach` around the codex dispatch fake shim. Not touched by
  T-01216 or this spec.

## 6. Out of scope

- Extending the ACP surface to expose these verbs. Most operators are
  on `hrc` directly; punt on ACP mirroring until a concrete user shows
  up.
- Broader observability work (dashboards, Prometheus metrics). The
  existing `session.generation_auto_rotated` HRC event stream is
  enough for audit; dashboards can consume that later.
- Per-agent or per-project quota/GC policy. Sweep is an imperative
  operator tool, not a scheduled janitor. A future proposal could add
  a timed sweep loop inside hrc-server if it proves necessary.

## 7. Pick-up checklist for the next session

1. Read this file end to end.
2. Decide on open questions §4; mark decisions inline.
3. Land the minimum-viable headless `terminateRuntime` branch first
   (§3.1 first bullet) on a fresh branch off `main` once T-01216
   merges. Confirm with clod@media-ingest first (DM #528) so the
   rt-3b0b77d0 case is handled.
4. Build out `runtime sweep` + CLI surface in a follow-up PR.
5. Sweep any leftover stale headless runtimes once the CLI is live;
   then mark T-01216 `completed` on the wrkq if not already.
