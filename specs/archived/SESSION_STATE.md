# HRC Session State Changes During `hrcchat dm`

This document describes how `POST /v1/messages/dm` changes persisted state in `hrc-server` for the main session/runtime scenarios.

Primary code paths:
- `handleSemanticDm` in `packages/hrc-server/src/index.ts`
- `ensureTargetSession`
- `executeSemanticTurn`
- `dispatchTurnForSession`
- `ensureRuntimeForSession`
- `handleSdkDispatchTurn`
- `handleContinuation`

Important framing:
- The session row's own `status` usually stays `active`.
- The visible "state" of a target is derived later from session + runtime by `toTargetState(...)`:
  - `summoned`: active session, no usable runtime
  - `busy`: runtime is `busy` or `starting`
  - `bound`: active session with usable idle runtime
- `hrcchat dm` always writes a durable message record first, even if no execution happens.

## Objects That Change

The main records affected by a DM are:
- `sessions`
- `continuities`
- `runtimes`
- `runs`
- `messages`
- `events`

## Baseline DM Flow

For a DM sent to `to.kind = "session"`:

1. Insert request message with `execution.state = "not_applicable"`.
2. Resolve target session.
3. If a live tmux runtime exists, try literal delivery into the pane.
4. Otherwise, execute a semantic turn using either:
   - SDK dispatch, or
   - tmux/headless dispatch.
5. Update the message execution block with the chosen runtime/run/transport.

## Scenario 1: No Session Exists

Initial persisted state:
- No `continuities` row for the target `scopeRef/laneRef`
- No `sessions` row
- No `runtimes`
- No `runs`

If `createIfMissing` is not `false` and a `runtimeIntent` is supplied:

### Step A: DM request is recorded

`messages`:
- insert request DM
- `execution.state = "not_applicable"`

No other records change yet.

### Step B: Session is auto-created

`sessions`:
- insert new row
- `hostSessionId = new id`
- `generation = 1`
- `status = "active"`
- `lastAppliedIntentJson = runtimeIntent`

`continuities`:
- upsert active continuity for `scopeRef/laneRef`
- `activeHostSessionId = new hostSessionId`

`events`:
- append `session.created`

Derived target state:
- `summoned`

### Step C1: If DM dispatch takes the SDK path

`sessions`:
- `updateIntent(...)`

`runtimes`:
- insert SDK runtime
- `transport = "sdk"`
- `status = "busy"`
- `activeRunId = runId`
- `continuation = session.continuation` if present

`runs`:
- insert run with `transport = "sdk"`
- `accepted -> started -> completed` or `failed`

`events`:
- `runtime.created`
- `turn.accepted`
- `turn.started`
- `turn.completed`
- plus adapter-generated HRC events during SDK execution

`messages`:
- update request DM execution to:
  - `state = "completed"` on success
  - `transport = "sdk"`
  - `mode = "nonInteractive"`
  - `runtimeId`, `runId`, `hostSessionId`, `generation`

If final SDK output is non-empty:
- insert response DM message

If SDK returns a continuation:

`sessions`:
- `updateContinuation(...)`

`runtimes`:
- SDK runtime updated with new continuation and `status = "ready"`
- `activeRunId` cleared

Derived target state:
- `summoned -> busy -> bound`

### Step C2: If DM dispatch takes the tmux/headless path

`sessions`:
- `updateIntent(...)`

`runtimes`:
- ensure or insert tmux runtime
- if new runtime:
  - previous runtime, if any, is marked `terminated`
  - new runtime inserted with:
    - `transport = "tmux"`
    - `status = "ready"`
    - `tmuxJson = pane/session metadata`
- then runtime updated again for dispatch:
  - `status = "busy"`
  - `activeRunId = runId`
  - `launchId = launchId`

`runs`:
- insert tmux run
- `status = "accepted" -> "started"`

`events`:
- `runtime.created` or `runtime.ensured`
- `turn.accepted`
- `turn.started`

`messages`:
- update request DM execution to:
  - `state = "started"`
  - `transport = "tmux"`
  - `mode = "headless"`
  - `runtimeId`, `runId`, `hostSessionId`, `generation`

Later, if the launched harness posts a continuation callback:

`sessions`:
- `updateContinuation(...)`

`runtimes`:
- runtime continuation updated

`events`:
- `launch.continuation_captured`

Derived target state:
- `summoned -> busy`

Notes:
- For tmux dispatch, the DM call itself returns while the launched work is still in progress.
- For one-shot tmux dispatch launched from `dispatchTurnForSession(...)`, the launch exit path currently clears `activeRunId`, completes the run, and marks the runtime `terminated`.
- That means the common end-state for these dispatch-created runtimes is `busy -> summoned`, not `busy -> bound`.
- `busy -> bound` is more characteristic of long-lived interactive tmux runtimes that remain alive and reusable.

## Scenario 2: Session Exists With Continuation, But No Live tmux Runtime

Initial persisted state:
- `sessions` row exists
- `sessions.status = "active"`
- `sessions.continuation` exists
- `continuities.activeHostSessionId` already points at this session
- no usable live tmux runtime

Typical derived target state before the DM:
- usually `summoned`
- can also be `bound` if a ready SDK runtime already exists for the session

### Step A: DM request is recorded

`messages`:
- insert request DM
- `execution.state = "not_applicable"`

### Step B: Existing session is reused

`sessions`:
- no new row
- continuity is unchanged

### Step C1: SDK dispatch

This is the clearest case where stored continuation matters immediately.

`sessions`:
- `updateIntent(...)`

`runtimes`:
- insert SDK runtime with:
  - `continuation = session.continuation`
  - `status = "busy"`

`runs`:
- insert SDK run

SDK execution receives:
- `existingProvider` from latest runtime or session continuation
- `continuation` from session

After completion:

`sessions`:
- `updateContinuation(...)` if a newer continuation is returned

`runtimes`:
- runtime set to `ready`
- `activeRunId` cleared
- continuation/harness session metadata updated

`messages`:
- request execution updated to `completed`
- optional response DM inserted from final SDK output

Derived target state:
- `summoned -> busy -> bound`

### Step C2: OpenAI `headless` or `nonInteractive` dispatch

After the tmux fallback fix, these intents do not drop into the SDK adapter merely because tmux is absent.

What changes:
- runtime intent is normalized into a tmux-provisionable form
- a fresh or reused tmux runtime is ensured
- the turn is dispatched through tmux as a real CLI launch

`sessions`:
- `updateIntent(...)`

`runtimes`:
- ensure/insert tmux runtime
- then mark it `busy` with `activeRunId` and `launchId`

`runs`:
- insert tmux run

`messages`:
- request execution updated to `started`
- `transport = "tmux"`
- `mode = "headless"`

Important detail:
- the pre-existing session continuation is not the primary dispatch mechanism here
- instead, HRC provisions tmux and launches the CLI there
- a later continuation callback may replace the stored continuation

Derived target state:
- `summoned -> busy`
- commonly `busy -> summoned` after launch exit terminates the one-shot dispatch runtime

## Scenario 3: Live tmux Runtime Exists

Initial persisted state:
- `sessions` row exists and is `active`
- latest runtime exists with `transport = "tmux"`
- runtime is not unavailable

Derived target state before the DM:
- `bound` if the runtime is idle
- `busy` if the runtime is already running something

### Step A: DM request is recorded

`messages`:
- insert request DM
- `execution.state = "not_applicable"`

### Step B: Literal tmux delivery is attempted

`handleSemanticDm` prefers literal pane delivery when a live tmux runtime exists.

What happens:
- build DM payload text
- `tmux.sendLiteral(...)`
- short sleep
- `tmux.sendEnter(...)`

### Persisted changes

`messages`:
- request DM execution updated directly to:
  - `state = "completed"`
  - `transport = "tmux"`
  - `mode = "headless"`
  - `runtimeId = existing runtime`
  - `hostSessionId`, `generation`

What does not change:
- no new session row
- no continuity change
- no new runtime row
- no new run row
- no `sessions.updateIntent(...)`
- no `sessions.updateContinuation(...)`

Derived target state:
- unchanged
- stays `bound` or `busy` depending on the existing runtime

This path is "deliver text into the live terminal", not "create a new semantic turn record in runs".

## Failure Path Notes

If live tmux literal delivery fails:
- the message is not immediately marked failed
- HRC falls back to `executeSemanticTurn(...)`
- from there it behaves like Scenario 2 or Scenario 1 semantic execution

If semantic execution throws:

`messages`:
- request DM execution updated to:
  - `state = "failed"`
  - `errorMessage = ...`

The session row itself still typically remains:
- `status = "active"`

## Summary Table

| Scenario | Session Row | Continuity | Runtime | Run | Message Execution | Derived Target State |
| --- | --- | --- | --- | --- | --- | --- |
| No session -> auto-summon | created, `active`, intent stored | created/updated | none at first, then SDK or tmux runtime | created if semantic turn runs | `not_applicable -> completed/started/failed` | absent -> `summoned` -> `busy/bound` for SDK, or `summoned -> busy -> summoned` for one-shot tmux dispatch |
| Session exists + continuation, no live tmux | reused, intent may update, continuation may refresh | unchanged | new SDK runtime or newly ensured tmux runtime | created for semantic turn | `not_applicable -> completed/started/failed` | usually `summoned -> busy -> bound` for SDK, or `summoned -> busy -> summoned` for one-shot tmux dispatch |
| Live tmux exists | unchanged | unchanged | unchanged | no new run | `not_applicable -> completed` | unchanged (`bound` or `busy`) |

## Practical Interpretation

When debugging "session state" during `hrcchat`:
- look at `sessions.status` only to see whether the session is broadly active/broken
- look at `continuities` to see which host session is current
- look at `runtimes.status`, `transport`, and `activeRunId` to understand actual execution state
- look at `messages.execution` to see what the DM itself did
- use `toTargetState(...)` as the user-facing summary of those combined records
