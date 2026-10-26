# Headless Runtime Plan

This document captures the implementation plan to make OpenAI headless execution in `hrc-server` independent of tmux.

The goal is:
- headless dispatch should not leave behind a tmux session
- headless execution should still persist continuation
- later attach should provision a fresh tmux runtime and resume from continuation using `codex resume`

This plan is intended to be sufficient context for implementation without referring back to prior chat.

## Implementation Status

Status as of 2026-04-16: complete in code; live deployment still depends on restarting the shared HRC daemon.

Implemented:
- OpenAI headless and non-interactive flows now use a real `transport = 'headless'` runtime instead of provisioning tmux up front.
- Headless start and headless DM fallback persist continuation without requiring a surviving tmux session.
- Later attach provisions or reuses interactive tmux only when needed and resumes with `codex resume`.
- Public contracts and target/runtime views expose `transport = 'headless'`.
- Headless runtime exit now preserves resumability instead of marking the runtime unavailable.
- Attach-created tmux runtimes now transition to unavailable immediately when the harness exits, so resumability is controlled by harness lifecycle rather than waiting for tmux pane cleanup.
- Attach rematerialization no longer revives an unavailable prior runtime record just because stale tmux pane metadata still exists.
- `hrc attach` now retries against a refreshed runtime list if an initially selected tmux runtime becomes stale during attach.
- `hrc start --new-session` now rotates to a fresh host session, drops inherited continuation, and starts a fresh headless runtime instead of reusing the prior conversation thread.
- The launch wrapper banner now prints the resume session id for Codex resume launches and shows the full Codex command under a `── command ──` header.

Verified:
- targeted server lifecycle tests for headless start, attach, and DM fallback pass
- targeted CLI attach tests, including stale-runtime retry behavior, pass
- targeted server and CLI tests for `clear-context`/`start --new-session` continuation dropping pass
- targeted launch wrapper tests for continuation capture and summary output pass
- real PTY e2e on `larry@agent-spaces~verifyquit` confirms `attach` -> `/quit` -> shell `exit` leaves the headless runtime `ready`, marks the interactive tmux runtime unavailable immediately, and allows the next `attach` to rematerialize on the first follow-up call
- live attach against Larry `main` still recovers cleanly when a stale tmux runtime coexists with a resumable headless runtime
- isolated live CLI e2e with a fresh daemon confirms `hrc start <scope> --new-session` archives the old host session, creates a new host session, and the new session receives a different continuation key
- on the shared Larry `main` daemon, repeated `hrc start --new-session` still inherited the old continuation until the daemon is restarted; that server was still running the pre-change process

No remaining implementation steps from this plan are open.

## Problem Statement

Today, OpenAI headless flows are semantically "headless" at the CLI level, but operationally still rely on tmux as the runtime container.

That creates a mismatch:
- `codex exec --json` is a one-shot detached headless process
- but HRC still provisions a tmux runtime before launching it
- the persisted runtime is tmux-backed
- later attach assumes that tmux runtime still exists

This is true for both:
- `POST /v1/runtimes/start` in headless mode
- `POST /v1/messages/dm` fallback / semantic turn dispatch for OpenAI headless

The intended behavior is different:
- headless dispatch should not depend on a persistent tmux session
- only continuation should be persisted
- when an operator later attaches, HRC should create a fresh tmux pane and run `codex resume`

## Current Behavior

### Current invocation mapping

In `packages/hrc-server/src/agent-spaces-adapter/cli-adapter.ts`:
- OpenAI `preferredMode = 'headless'` or `'nonInteractive'` maps to:
  - `interactionMode = 'headless'`
  - `ioMode = 'pipes'`

This part is correct and should stay.

### Current runtime model

In `packages/hrc-server/src/index.ts`, headless OpenAI flows still route through tmux-backed runtime provisioning:

- `dispatchTurnForSession(...)`
  - currently provisions or reuses tmux runtime for the tmux path
  - for OpenAI headless/nonInteractive, recent fixes cause the no-runtime fallback to provision tmux rather than SDK
- `ensureRuntimeForSession(...)`
  - provisions tmux runtime records
- `startRuntimeForSession(...)`
  - for headless Codex start, still begins with tmux runtime provisioning
- `runHeadlessStartLaunch(...)`
  - runs the launch wrapper directly and captures continuation
  - but the runtime being updated is still tmux-backed
- `attachRuntimeEffectfully(...)`
  - assumes an attachable tmux runtime or at least a tmux runtime record to target
- `enqueueAttachLaunch(...)`
  - sends `codex resume` into an existing tmux pane

### Current launch-exit behavior

In `handleLaunchExited(...)` in `packages/hrc-server/src/index.ts`:
- if the launch has a `runtimeId`
  - `activeRunId` is cleared
  - active run is completed
  - runtime status is set to `terminated`

This currently treats the runtime as an expended container after the one-shot launch exits.

Important nuance:
- the code does not explicitly kill the tmux session in `handleLaunchExited(...)`
- but the runtime record becomes unavailable because its status becomes `terminated`
- later liveness reconciliation and attach logic treat terminated tmux runtimes as unavailable

### Why this is wrong for the intended model

The current model conflates two separate things:
- process lifecycle for a one-shot headless execution
- lifecycle of an attachable interactive tmux runtime

For the intended headless model:
- the one-shot headless execution should end cleanly
- continuation should remain usable
- there should be no requirement to keep tmux alive
- attach should materialize a new interactive tmux runtime from continuation

## Target Behavior

### Desired lifecycle

For OpenAI headless dispatch:
1. No tmux runtime is provisioned up front.
2. HRC creates or reuses a headless runtime record.
3. HRC launches `codex exec --json` through the launch wrapper directly.
4. Continuation is captured and stored on the session/runtime.
5. The run completes.
6. The headless runtime remains resumable, but not attachable.
7. No persistent tmux session remains from the headless run.

For later attach:
1. If a live tmux runtime already exists, attach to it as today.
2. Otherwise, if a resumable continuation exists:
   - provision a fresh tmux runtime
   - enqueue `codex resume` into it
   - return the tmux attach descriptor

### Architectural principle

Treat "headless" as a real runtime transport, not just a Codex CLI execution mode inside a tmux runtime.

New distinction:
- execution mode:
  - `interactive`
  - `headless`
- runtime transport:
  - `sdk`
  - `tmux`
  - `headless`

## Proposed Runtime Model

### Add `transport: 'headless'`

Headless runtime records should:
- not have `tmuxJson`
- not be attachable directly
- be able to store:
  - `continuation`
  - `harnessSessionJson`
  - `launchId`
  - `activeRunId`

Recommended semantics:
- while a headless run is executing:
  - `status = 'busy'`
  - `activeRunId = runId`
- after successful completion:
  - either:
    - `status = 'ready'`, but interpreted as resumable-only for headless transport
    - or better, add a new status such as `detached`

Recommendation:
- keep status changes minimal unless schema churn is acceptable
- if possible, add `status = 'detached'` for clarity
- if not, use `status = 'ready'` and make transport-specific attachability decisions

## Proposed Implementation Changes

## 1. Explicit transport branching in dispatch

### Current problem

`dispatchTurnForSession(...)` currently branches between:
- SDK path
- tmux path

For OpenAI headless/nonInteractive it now falls into tmux path if no idle tmux exists.

### Change

Refactor `dispatchTurnForSession(...)` to branch explicitly among:
- SDK transport
- tmux transport
- headless transport

Suggested helpers:
- `shouldUseSdkTransport(intent)`
- `shouldUseHeadlessTransport(intent)`
- `shouldUseTmuxTransport(intent)`

Recommended logic:
- OpenAI `preferredMode=headless|nonInteractive` => headless transport
- true interactive attachable flows => tmux transport
- Anthropic or other supported non-interactive adapter flows => SDK transport

### New function

Add:
- `handleHeadlessDispatchTurn(session, intent, prompt, runId): Promise<Response>`

Responsibilities:
- create or reuse a headless runtime record
- create run record
- launch via wrapper directly, no tmux provisioning
- capture continuation
- complete run
- update message-visible response with `transport: 'headless'`

## 2. Introduce headless runtime creation/reuse

### Current problem

`ensureRuntimeForSession(...)` only provisions tmux runtimes.

### Change

Do not overload `ensureRuntimeForSession(...)` to support headless.

Add separate helpers:
- `createHeadlessRuntimeForSession(...)`
- `getReusableHeadlessRuntimeForSession(...)`

Suggested behavior:
- if an existing headless runtime for the session/provider has stored continuation and is not unavailable, reuse it
- otherwise insert a new headless runtime

Fields:
- `transport = 'headless'`
- `runtimeKind = 'harness'`
- `provider = intent.harness.provider`
- `harness = 'codex-cli'` for OpenAI headless
- `supportsInflightInput = false`
- `continuation = session.continuation` when appropriate

## 3. Change `hrc start` headless path to use headless transport

### Current problem

`startRuntimeForSession(...)` starts from tmux provisioning even for headless Codex.

### Change

In `startRuntimeForSession(...)`:
- if `requiresHeadlessCodexStart(...)`:
  - do not call `ensureRuntimeForSession(...)`
  - create or reuse headless runtime instead
  - call a headless launch runner that does not assume tmux backing

Suggested new function:
- `runHeadlessStartLaunch(session, runtime, intent)` can remain, but it must operate on a headless runtime record, not a tmux runtime

Desired result:
- `POST /v1/runtimes/start` in headless mode leaves behind a resumable headless runtime
- not a terminated tmux runtime

## 4. Change `hrcchat dm` headless fallback to use headless transport

### Current problem

After the recent fallback fix, OpenAI `nonInteractive` DM fallback provisions tmux and dispatches there.

### Change

For `POST /v1/messages/dm` semantic turn execution:
- OpenAI headless/nonInteractive should use `handleHeadlessDispatchTurn(...)`
- no tmux should be provisioned during the dispatch itself

Desired result:
- DM fallback produces a resumable continuation-backed headless runtime
- no persistent tmux session is left behind

## 5. Update launch artifacts for headless transport

### Current problem

Current tmux dispatch/start paths add:
- `AGENTCHAT_TRANSPORT=tmux`
- `AGENTCHAT_TARGET=...`

These are correct only when a real tmux runtime exists.

### Change

For headless launch artifacts:
- do not set tmux transport env vars
- do not include tmux target assumptions
- allow launch wrapper to operate without tmux registration

In `packages/hrc-server/src/launch/exec.ts`:
- agentchat registration should remain conditional on env presence
- headless launches should run fine without `AGENTCHAT_TRANSPORT` / `AGENTCHAT_TARGET`

## 6. Fix launch-exit handling for headless runtimes

### Current problem

`handleLaunchExited(...)` currently marks the runtime `terminated` for launch-bound runtimes.

That is reasonable for an expended tmux runtime container, but wrong for a resumable headless runtime.

### Change

In `handleLaunchExited(...)`:
- branch on runtime transport

For `transport = 'headless'`:
- clear `activeRunId`
- complete the run
- do not mark the runtime unavailable
- preserve `continuation`
- set status to:
  - `detached`, if introduced
  - otherwise `ready`

For `transport = 'tmux'`:
- keep current semantics unless interactive runtime behavior is being changed separately

## 7. Make attach materialize tmux from continuation

### Current problem

`attachRuntimeEffectfully(...)` assumes the runtime being attached is already tmux-backed.

That means resumability currently depends on surviving tmux state.

### Change

Refactor `attachRuntimeEffectfully(...)`:

Case A: runtime transport is `tmux`
- current behavior

Case B: runtime transport is `headless`
- if continuation exists:
  1. provision a fresh tmux runtime using `ensureRuntimeForSession(...)` with interactive intent
  2. enqueue `codex resume` into that pane using existing `enqueueAttachLaunch(...)`
  3. return attach descriptor for the new tmux runtime

Questions to decide:
- Should attach create a brand-new tmux runtime record and leave the headless runtime as historical?
- Or should attach mutate/replace the headless runtime record into tmux?

Recommendation:
- create a new tmux runtime record
- leave the headless runtime as historical evidence of the detached run
- if needed, continuity can still remain at session level; attach acts on runtime ID chosen by caller

Alternative:
- update session-level continuity to point future operations toward the new interactive tmux runtime

## 8. State and capability derivation

### Current problem

`toTargetState(...)` and `toTargetCapabilities(...)` are tmux/sdk oriented.

### Change

Update `toTargetState(...)`:
- `tmux` ready => `bound`
- `sdk` ready => likely `bound` or current semantics
- `headless` idle => probably `summoned`, because there is no live attachable transport
- any transport with active run => `busy`

Update `toTargetCapabilities(...)`:
- `sendReady` only when there is live tmux transport
- `peekReady` should be evaluated transport-specifically
- `dmReady` should remain true if there is usable intent or continuation
- `modesSupported` should include:
  - `headless` for headless transport or interactive intents supporting headless start
  - `nonInteractive` for sdk flows as appropriate

## 9. Revisit liveness reconciliation

### Current problem

`reconcileTmuxRuntimeLiveness(...)` is correct for tmux runtimes, but headless runtimes should never go through tmux liveness reconciliation.

### Change

Ensure:
- headless runtimes are skipped by tmux-specific liveness checks
- attach/capture endpoints handle headless transport explicitly

Expected behavior:
- `GET /v1/attach` for headless runtime should trigger attach materialization from continuation
- `GET /v1/capture` for headless runtime should probably use buffered output if available, similar to SDK

## 10. Message execution / API response semantics

### Current problem

DM and selector dispatch responses currently collapse transport into `sdk` vs `tmux`.

### Change

Allow `transport = 'headless'` in relevant response payloads where appropriate.

This affects:
- DM execution response
- selector dispatch response
- possibly target/runtime view serialization

If external API compatibility is a concern:
- consider reporting `mode = 'headless'` while keeping transport internal
- but this is less clean than exposing the real transport

Recommendation:
- expose `transport = 'headless'`

## Suggested Refactoring Sequence

Implement in this order to reduce breakage:

1. Introduce `headless` transport in runtime typing and serialization.
2. Add headless runtime creation/reuse helpers.
3. Add `handleHeadlessDispatchTurn(...)`.
4. Switch `dispatchTurnForSession(...)` OpenAI headless/nonInteractive path to `headless`.
5. Switch `startRuntimeForSession(...)` headless path to create/reuse headless runtime instead of tmux runtime.
6. Update `handleLaunchExited(...)` to preserve resumable headless runtime after process exit.
7. Update `attachRuntimeEffectfully(...)` to provision fresh tmux from headless continuation.
8. Update target state/capability derivation.
9. Update capture/attach/list endpoints for headless transport.
10. Remove now-obsolete tmux assumptions from headless code paths.

## Key Code Areas To Change

Primary file:
- `packages/hrc-server/src/index.ts`

Specific areas:
- `dispatchTurnForSession(...)`
- `startRuntimeForSession(...)`
- `runHeadlessStartLaunch(...)`
- `handleLaunchExited(...)`
- `attachRuntimeEffectfully(...)`
- `enqueueAttachLaunch(...)`
- `toTargetState(...)`
- `toTargetCapabilities(...)`
- response serializers that currently assume only `sdk | tmux`

Secondary files:
- `packages/hrc-server/src/agent-spaces-adapter/cli-adapter.ts`
  - mostly confirm current headless invocation mapping remains correct
- `packages/hrc-server/src/launch/exec.ts`
  - ensure headless launches operate without tmux registration assumptions
- any runtime view / schema / API typing sites that enumerate transports

## Test Plan

## A. Headless start

Add or update tests to prove:

1. `POST /v1/runtimes/start` with OpenAI headless:
- returns success
- creates `transport = 'headless'` runtime
- does not store `tmuxJson`
- persists continuation

2. Second identical headless start:
- reuses the resumable headless runtime if continuation already exists

3. After headless start completes:
- runtime is not marked unavailable
- runtime remains resumable

## B. Headless attach

Add tests for:

1. Attach on headless runtime with continuation:
- provisions fresh tmux runtime
- enqueues `codex resume`
- returns tmux attach descriptor

2. Attach when continuation is missing:
- returns a clear runtime unavailable error

3. Repeated attach:
- avoids duplicate resume launches when an attach launch is already in flight

## C. Headless DM fallback

Add tests for:

1. `POST /v1/messages/dm` with OpenAI `nonInteractive` fallback:
- does not create tmux runtime for the dispatch itself
- creates `headless` runtime
- persists continuation
- reports `mode = 'headless'`

2. After the headless DM run exits:
- no live tmux runtime is required
- session remains resumable from continuation

3. Later attach after DM-created headless runtime:
- provisions fresh tmux runtime
- resumes correctly

## D. tmux interactive flows remain unchanged

Regression tests:
- interactive tmux start still provisions tmux
- literal DM delivery into live tmux still bypasses run creation
- SDK non-interactive flows still use SDK

## E. State derivation

Tests for `toTargetState(...)` and target views:
- headless idle runtime should not read as `bound`
- live tmux idle runtime should read as `bound`
- busy headless runtime should read as `busy`

## Resolved Decisions

1. Headless idle status remains `ready`.
- A new `detached` status was not introduced.
- Transport-specific behavior now distinguishes resumable headless runtimes from attachable tmux runtimes.

2. Attach from a headless runtime creates or reuses interactive tmux runtime state rather than mutating the headless runtime into tmux.
- Session continuity remains at the session/runtime level through persisted continuation and latest active runtime selection.

3. Historical headless runtimes remain listed after attach creates a tmux runtime.
- This preserves detached execution history and keeps attach/resume behavior explicit.

4. `transport = 'headless'` is exposed on public APIs.
- This shipped in the core HTTP and hrcchat contracts.

## Minimal Acceptance Criteria

This work is done when all of the following are true:

1. Headless OpenAI execution no longer provisions tmux up front. Complete.
2. Headless execution persists continuation. Complete.
3. Headless execution does not require a surviving tmux session to be resumable. Complete.
4. Attach on a headless runtime provisions a fresh tmux runtime and resumes from continuation. Complete.
5. `hrcchat dm` headless fallback behaves the same way as `hrc start` headless. Complete.
6. Interactive tmux and SDK flows continue to behave as before. Complete.

## Practical Summary

The implementation should move HRC from:
- "headless Codex process running inside a tmux-backed runtime"

to:
- "headless runtime persists continuation only"
- "tmux is provisioned only when interactive attach/resume is requested"

That is the cleanest way to match the intended behavior:
- no leftover tmux session from headless dispatch
- resumability preserved
- interactive attach still works by creating tmux only when needed

Plan conclusion:
- all steps in this document are complete
- follow-up work, if any, should be tracked in a new session or a new plan document rather than as open work here
