# Specification: Interactive Claude Runtime Idle/Busy Synchronization

## 1. Objective

Implement accurate `ready`/`busy` state tracking for HRC-managed interactive Claude runtimes that execute inside tmux. After this change, an interactive Claude runtime must report `ready` when the TUI is idle at its prompt, `busy` while a user turn is executing, and `dead` only when the tmux-backed session is no longer present.

## 2. Scope

This specification applies only to tmux-backed interactive runtimes started through HRC launch artifacts and executed by the Claude harness. It covers launch-time startup, manual user turns inside the Claude TUI, hook delivery, spool replay, and runtime start idempotence.

This specification does not change SDK runtimes, headless Codex startup, continuation capture, or run admission control. In particular, `assertRuntimeNotBusy()` remains `activeRunId`-based; this work does not make manual Claude turns authoritative for HRC run dispatch admission.

## 3. Existing System Context

### 3.1 Interactive launch lifecycle

An interactive tmux runtime currently follows this control path:

1. `ensureRuntimeForSession()` creates or refreshes the runtime and sets `runtime.status = "ready"`.
2. `enqueueInteractiveStartLaunch()` creates a launch record, sets `runtime.launchId`, and sets `runtime.status = "starting"`.
3. `packages/hrc-server/src/launch/exec.ts` runs inside the tmux pane, posts `/wrapper-started`, spawns the harness child, posts `/child-started`, and then waits for the child to exit.
4. `handleWrapperStarted()` and `handleChildStarted()` set `runtime.status = "busy"`.
5. `handleExited()` calls `resolveRuntimeStatusAfterLaunchExit()` and transitions the runtime to `ready` or `dead` only when the launch process exits.

Because the launch wrapper stays alive for the entire interactive Claude session, `/exited` is not emitted while the TUI is merely idle. A separate lifecycle signal is therefore required to represent idle-vs-busy state within a still-live interactive session.

### 3.2 Hook delivery pipeline

The repository already contains the hook transport required for this implementation:

- `packages/config/src/materializer/hooks-toml.ts` translates canonical hook events such as `session_start`, `user_prompt_submit`, and `stop` into Claude-native hook configuration.
- Claude hook scripts receive JSON on stdin.
- `packages/hrc-server/src/launch/hook-cli.ts` reads stdin JSON, wraps it in an HRC hook envelope, and posts it to `POST /v1/internal/hooks/ingest`.
- When the callback socket is unavailable, `hook-cli.ts` spools the payload for startup replay.
- `packages/hrc-server/src/index.ts` already replays spooled `/v1/internal/hooks/ingest` entries during startup via `replaySpoolEntry()`.

### 3.3 Priming prompt signal

`packages/harness-claude/src/adapters/claude-adapter.ts` exports `ASP_PRIMING_PROMPT` into the Claude launch environment when a priming prompt is present. This is the required signal for distinguishing a no-initial-prompt startup from a startup that is already executing the first turn.

### 3.4 Claude plugin layout

This specification defines required files in the materialized Claude plugin bundle. The source-tree location used to generate those files is implementation-defined. In the composed target bundle, the files must exist under a plugin root of the form:

```text
asp_modules/<target>/plugins/<NNN-plugin-id>/
```

Within that plugin root, hooks must follow the standard layout:

```text
hooks/hooks.toml
hooks/scripts/<script>.sh
```

## 4. Required Runtime Semantics

### 4.1 Startup without an initial prompt

For an interactive Claude runtime started without a priming prompt, the required state sequence is:

```text
ready -> starting -> busy -> ready
```

The final transition to `ready` must occur when Claude emits the startup `session_start` hook.

### 4.2 Startup with an initial prompt

For an interactive Claude runtime started with a priming prompt, the required state sequence is:

```text
ready -> starting -> busy
```

The runtime must remain `busy` until the first Claude turn finishes. The startup `session_start` hook must not transition the runtime to `ready` in this case.

### 4.3 Manual turn lifecycle inside the TUI

After startup, each manual Claude turn must produce this state sequence:

```text
ready -> busy -> ready
```

`user_prompt_submit` marks turn start. `stop` marks turn completion.

### 4.4 Session termination

When the interactive Claude process exits and tmux still exists, `/exited` continues to resolve the runtime to `ready`. When the tmux session is gone, `/exited` continues to resolve the runtime to `dead`. No change is required to `resolveRuntimeStatusAfterLaunchExit()`.

### 4.5 HRC-managed runs remain authoritative

Hook-driven state transitions must not alter `activeRunId`, run records, or launch exit handling. If `runtime.activeRunId !== undefined`, hook ingestion must record receipt of the hook but must not mutate runtime status.

## 5. Hook Contract

### 5.1 Hook envelope

No schema change is required for the outer HRC hook envelope. `hook-cli.ts` must continue to submit:

```ts
{
  launchId: string,
  hostSessionId: string,
  generation: number,
  runtimeId?: string,
  hookData: unknown,
}
```

### 5.2 Lifecycle payload inside `hookData`

The inner lifecycle contract is:

```ts
type HookLifecycleKind = 'runtime.ready' | 'turn.started' | 'turn.stopped'

type HookLifecyclePayload = {
  kind: HookLifecycleKind
  hookEvent: unknown
}
```

`hookEvent` is the original Claude hook JSON from stdin and must be preserved as opaque data.

### 5.3 Accepted lifecycle kinds

The server must interpret only these `hookData.kind` values for runtime mutation:

| `hookData.kind` | Source Claude hook | Runtime effect |
|---|---|---|
| `runtime.ready` | `session_start` with `matcher = "startup"` | set runtime to `ready` |
| `turn.started` | `user_prompt_submit` | set runtime to `busy` |
| `turn.stopped` | `stop` | set runtime to `ready` |

All other `hookData` values must be stored via `hook.ingested` and otherwise ignored.

## 6. Claude Plugin Requirements

### 6.1 Required hook definitions

The default Claude plugin artifact included in interactive Claude targets must contain the following entries in `hooks/hooks.toml`:

```toml
[[hook]]
event = "session_start"
matcher = "startup"
script = "hooks/scripts/session-ready.sh"
harness = "claude"

[[hook]]
event = "user_prompt_submit"
script = "hooks/scripts/turn-started.sh"
harness = "claude"

[[hook]]
event = "stop"
script = "hooks/scripts/turn-stopped.sh"
harness = "claude"
```

`matcher = "startup"` on `session_start` is mandatory. The startup-ready transition must not run for non-startup `session_start` variants such as compaction-related session starts.

### 6.2 Required shell scripts

The plugin must include executable scripts at:

```text
hooks/scripts/session-ready.sh
hooks/scripts/turn-started.sh
hooks/scripts/turn-stopped.sh
```

Each script must be executable and must consume stdin, emit no user-visible output, never block Claude on failure, and always exit with status `0`.

#### `hooks/scripts/session-ready.sh`

```bash
#!/usr/bin/env bash
INPUT="$(cat)"

if [ -n "${ASP_PRIMING_PROMPT:-}" ]; then
  exit 0
fi

if [ -z "${HRC_LAUNCH_HOOK_CLI:-}" ]; then
  exit 0
fi

printf '{"kind":"runtime.ready","hookEvent":%s}\n' "$INPUT" \
  | bun run "$HRC_LAUNCH_HOOK_CLI" >/dev/null 2>&1 || true

exit 0
```

#### `hooks/scripts/turn-started.sh`

```bash
#!/usr/bin/env bash
INPUT="$(cat)"

if [ -z "${HRC_LAUNCH_HOOK_CLI:-}" ]; then
  exit 0
fi

printf '{"kind":"turn.started","hookEvent":%s}\n' "$INPUT" \
  | bun run "$HRC_LAUNCH_HOOK_CLI" >/dev/null 2>&1 || true

exit 0
```

#### `hooks/scripts/turn-stopped.sh`

```bash
#!/usr/bin/env bash
INPUT="$(cat)"

if [ -z "${HRC_LAUNCH_HOOK_CLI:-}" ]; then
  exit 0
fi

printf '{"kind":"turn.stopped","hookEvent":%s}\n' "$INPUT" \
  | bun run "$HRC_LAUNCH_HOOK_CLI" >/dev/null 2>&1 || true

exit 0
```

## 7. Launch Environment Requirements

`packages/hrc-server/src/launch/exec.ts` must export the absolute path to `hook-cli.ts` into the child harness environment as `HRC_LAUNCH_HOOK_CLI`.

Required change:

1. Add `fileURLToPath` from `node:url` if not already imported.
2. Add this variable to the environment passed to `spawn()`:

```ts
HRC_LAUNCH_HOOK_CLI: fileURLToPath(new URL('./hook-cli.ts', import.meta.url)),
```

No other hook transport environment changes are required. `exec.ts` already exports `HRC_LAUNCH_ID`, `HRC_HOST_SESSION_ID`, `HRC_GENERATION`, `HRC_RUNTIME_ID`, `HRC_CALLBACK_SOCKET`, and `HRC_SPOOL_DIR`.

## 8. Server-Side Hook Application Requirements

### 8.1 Shared application helper

Hook lifecycle application must be implemented once and used from both live ingest and spool replay. The implementation must not duplicate the runtime-transition rules in separate code paths.

A shared helper is required. The exact function name is implementation-defined. The helper must accept:

- the parsed `HookEnvelope`
- a `replayed: boolean` flag
- access to the database
- for the live path only, the server may additionally notify appended events after the helper returns

### 8.2 Stale launch rejection

`buildStaleLaunchCallbackRejection()` must be extended to accept a callback kind for hook ingest, for example `hook_ingest`.

The shared hook helper must invoke stale-launch rejection before applying any runtime mutation. If the callback is stale, it must append the rejection event and stop processing.

### 8.3 HTTP response behavior for ignored hooks

`handleHookIngest()` must always return a 2xx response for stale, ignored, or non-applicable hook callbacks.

This requirement is mandatory because `packages/hrc-server/src/launch/callback-client.ts` treats any non-2xx response as delivery failure, which would cause `hook-cli.ts` to spool stale or intentionally ignored callbacks indefinitely.

A valid response shape is:

```ts
json({ ok: true, ignored: 'stale' })
```

Equivalent 2xx responses with a different `ignored` reason are acceptable.

### 8.4 Runtime mutation rules

The shared hook helper must implement the following rules in order:

1. Parse the envelope with `parseHookEnvelope()`.
2. Resolve the session with `requireSession()`.
3. Append `hook.ingested`.
4. Run stale-launch rejection with callback kind `hook_ingest`.
5. If stale, append the rejection event and stop.
6. If `runtimeId` is absent, stop.
7. Resolve the runtime with `db.runtimes.getByRuntimeId()`.
8. If the runtime does not exist, stop.
9. If `runtime.transport !== "tmux"`, stop.
10. If the runtime is unavailable (`dead`, `terminated`, or equivalent existing unavailable states), stop.
11. If `runtime.activeRunId !== undefined`, stop.
12. Interpret `hookData.kind` and map it to the next runtime status:
    - `runtime.ready` -> `ready`
    - `turn.started` -> `busy`
    - `turn.stopped` -> `ready`
13. If the kind is unrecognized, stop.
14. Update `runtime.status`, `runtime.updatedAt`, and `runtime.lastActivityAt`.
15. Append a semantic hook event in the `hook.*` namespace.

The semantic hook event kinds must be:

- `hook.runtime_ready`
- `hook.turn_started`
- `hook.turn_stopped`

These names are mandatory. The implementation must not emit `turn.started` or `turn.stopped` for manual Claude hook transitions, because those names already identify HRC-managed run events elsewhere in the server.

### 8.5 Idempotence requirement

Hook lifecycle application must be safe under duplicate delivery. Re-applying the same lifecycle event for the same live launch must not produce an incorrect final runtime state.

### 8.6 Reference pseudocode

```ts
function applyHookLifecycleEnvelope(
  db: HrcDatabase,
  envelope: HookEnvelope,
  options: { replayed: boolean }
): HrcEventEnvelope[] {
  const events: HrcEventEnvelope[] = []
  const session = requireSession(db, envelope.hostSessionId)
  const now = timestamp()

  events.push(
    db.events.append({
      ts: now,
      hostSessionId: session.hostSessionId,
      scopeRef: session.scopeRef,
      laneRef: session.laneRef,
      generation: envelope.generation,
      runtimeId: envelope.runtimeId,
      source: 'hook',
      eventKind: 'hook.ingested',
      eventJson: {
        launchId: envelope.launchId,
        hookData: envelope.hookData,
        ...(options.replayed ? { replayed: true } : {}),
      },
    })
  )

  const rejection = buildStaleLaunchCallbackRejection(
    db,
    session,
    envelope.launchId,
    'hook_ingest',
    options.replayed
  )
  if (rejection) {
    events.push(rejection.event)
    return events
  }

  if (!envelope.runtimeId) return events

  const runtime = db.runtimes.getByRuntimeId(envelope.runtimeId)
  if (!runtime) return events
  if (runtime.transport !== 'tmux') return events
  if (isRuntimeUnavailableStatus(runtime.status)) return events
  if (runtime.activeRunId !== undefined) return events

  const kind = isRecord(envelope.hookData) ? envelope.hookData['kind'] : undefined
  const nextStatus =
    kind === 'runtime.ready'
      ? 'ready'
      : kind === 'turn.started'
        ? 'busy'
        : kind === 'turn.stopped'
          ? 'ready'
          : undefined

  if (!nextStatus) return events

  db.runtimes.update(runtime.runtimeId, {
    status: nextStatus,
    updatedAt: now,
    lastActivityAt: now,
  })

  events.push(
    db.events.append({
      ts: now,
      hostSessionId: session.hostSessionId,
      scopeRef: session.scopeRef,
      laneRef: session.laneRef,
      generation: envelope.generation,
      runtimeId: runtime.runtimeId,
      source: 'hook',
      eventKind:
        kind === 'runtime.ready'
          ? 'hook.runtime_ready'
          : kind === 'turn.started'
            ? 'hook.turn_started'
            : 'hook.turn_stopped',
      eventJson: {
        launchId: envelope.launchId,
        ...(options.replayed ? { replayed: true } : {}),
      },
    })
  )

  return events
}
```

## 9. Live Ingest Integration

`packages/hrc-server/src/index.ts` `handleHookIngest()` must:

1. Parse the request body with `parseHookEnvelope()`.
2. Call the shared helper with `replayed: false`.
3. Notify each appended event via `notifyEvent()`.
4. Return `json({ ok: true })` or `json({ ok: true, ignored: <reason> })` with a 2xx status.

`handleWrapperStarted()` and `handleChildStarted()` must remain unchanged with respect to launch startup state: they continue to set `runtime.status = "busy"`. The startup-ready transition is provided exclusively by the startup `session_start` hook.

## 10. Spool Replay Requirements

`replaySpoolEntry()` must call the same shared helper for `/v1/internal/hooks/ingest` payloads with `replayed: true`.

Replay behavior must be semantically identical to live behavior except that replay does not call `notifyEvent()`.

At a minimum, replay must preserve all of the following behaviors:

- append `hook.ingested`
- apply stale-launch rejection for hook callbacks
- ignore non-applicable callbacks without throwing
- mutate runtime status for `runtime.ready`, `turn.started`, and `turn.stopped`
- append semantic `hook.*` lifecycle events
- annotate replayed events with `replayed: true`

## 11. Runtime Start Idempotence Requirements

Once an idle interactive Claude runtime can legitimately report `status = "ready"`, `startRuntimeForSession()` must not use `runtime.status` alone to decide whether a new interactive launch is needed.

A tmux-backed interactive runtime must be reused when all of the following are true:

1. the runtime exists and is not unavailable
2. the intent does not require a headless Codex start
3. the runtime has a `launchId`
4. the corresponding launch record exists and belongs to the same runtime
5. the launch record is still live, meaning its status is one of the existing orphanable live statuses (`started`, `wrapper_started`, or `child_started`)
6. the tracked launch pid is either live, or not yet available

A helper equivalent to the following is required:

```ts
function hasLiveInteractiveLaunch(
  db: HrcDatabase,
  runtime: HrcRuntimeSnapshot
): boolean {
  if (runtime.transport !== 'tmux') return false
  if (!runtime.launchId) return false

  const launch = db.launches.getByLaunchId(runtime.launchId)
  if (!launch) return false
  if (launch.runtimeId !== runtime.runtimeId) return false
  if (!isOrphanableLaunchStatus(launch.status)) return false

  const trackedPid = getTrackedLaunchPid(launch)
  return trackedPid === undefined || isLiveProcess(trackedPid)
}
```

`startRuntimeForSession()` must return the existing runtime when either of these conditions holds:

- existing behavior: `runtime.status` is `busy` or `starting`
- new behavior: `hasLiveInteractiveLaunch(db, runtime) === true`

Without this change, an idle live Claude TUI that has transitioned to `ready` will be double-started by a second `/v1/runtimes/start` request.

## 12. Required Tests

The implementation must add or update tests to cover the following cases.

### 12.1 Hook materialization

Verify that canonical hook definitions produce Claude hook configuration with:

- `session_start` translated to `SessionStart`
- `matcher = "startup"` preserved on the `SessionStart` entry
- `user_prompt_submit` translated to `UserPromptSubmit`
- `stop` translated to `Stop`
- command paths rooted at `${CLAUDE_PLUGIN_ROOT}`

### 12.2 Launch environment

Verify that `exec.ts` exports `HRC_LAUNCH_HOOK_CLI` to the child harness environment.

### 12.3 Startup without priming prompt

Given an interactive Claude runtime with no `ASP_PRIMING_PROMPT`:

1. `child-started` sets the runtime to `busy`
2. a `runtime.ready` hook for the same live launch sets it to `ready`

### 12.4 Startup with priming prompt

Given an interactive Claude runtime with `ASP_PRIMING_PROMPT`:

1. `child-started` sets the runtime to `busy`
2. the startup hook script exits without sending `runtime.ready`
3. the runtime stays `busy` until `turn.stopped`
4. `turn.stopped` sets it to `ready`

### 12.5 Manual turn lifecycle

Given an idle live Claude runtime:

1. `turn.started` sets it to `busy`
2. `turn.stopped` sets it back to `ready`

### 12.6 HRC-managed run isolation

Given `runtime.activeRunId !== undefined`, `turn.started`, `turn.stopped`, and `runtime.ready` hooks must not mutate runtime status.

### 12.7 Stale hook handling

Given a hook for launch `A` after the runtime has moved to launch `B`:

1. the server appends a callback rejection event
2. the runtime status does not change
3. `handleHookIngest()` returns 2xx and does not force respooling of the stale callback

### 12.8 Replay parity

A spooled `/v1/internal/hooks/ingest` payload must produce the same runtime state transition and semantic `hook.*` events during replay as it does in the live path, with the addition of `replayed: true`.

### 12.9 Idempotent runtime start

Given a tmux-backed interactive runtime with `status = "ready"` and a live `child_started` launch, a second runtime start request must reuse the existing runtime and must not enqueue a second interactive start launch.

## 13. Acceptance Criteria

The implementation is complete when all of the following are true:

1. An interactive Claude runtime that is idle at the prompt reports `ready`.
2. A manual Claude turn transitions the runtime to `busy` on submit and back to `ready` on completion.
3. A primed startup remains `busy` until the primed turn finishes.
4. Stale hook callbacks are ignored safely without creating replay loops.
5. Startup replay preserves hook-driven lifecycle transitions.
6. A live idle Claude TUI is not double-started by repeated runtime-start requests.
