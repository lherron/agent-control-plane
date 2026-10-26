# `hrc monitor` Proposal

Status: HRC-focused revision (2026-04-27). ACP monitoring is deferred until the HRC work is complete.
Reviewers: cody@acp-spec
Original author: clod@agent-spaces
Current scope: HRC and hrcchat only

## 1. Decision

Build the HRC monitoring surface first, as a standalone product surface. HRC must remain useful and resilient without ACP running, without ACP task context, and without any ACP projection layer.

The clean CLI decision is:

- Add one coherent HRC monitoring family: `hrc monitor`.
- Remove top-level status/event/watch/wait commands and flags that duplicate agent/session/turn monitoring.
- Keep daemon lifecycle and liveness under `hrc server`, consolidated through `hrc server status`.
- Do not create legacy aliases, compatibility shims, or hidden fallback commands.
- Keep `hrcchat` as the semantic messaging entry point. Do not invent `hrc call`.
- Defer ACP monitoring until the HRC monitor semantics are implemented and proven.

After implementation, users should learn one place for HRC monitoring:

```bash
hrc monitor show
hrc monitor watch
hrc monitor wait
```

## 2. Motivation

The need comes from repeated agent coordination failures:

- An agent run fails or hangs and the caller receives no useful notification.
- A called agent finishes, but the calling agent does not wake up to process the next turn.
- The former hrcchat synchronous-DM wait flow behaved like a reply waiter, but produced noisy timeout/failure notifications that did not match the actual target runtime state.
- `hrc monitor watch --follow` has exited early, so operators fell back to polling.
- HRC and hrcchat currently spread monitoring/status responsibilities across several commands.

The surface should make "what is this runtime/session doing?" and "has the turn I care about finished?" answerable directly from HRC.

## 3. Removed Surface

These are removed after `hrc monitor` lands. They are not kept as aliases.

### 3.1 Removed from `hrc`

```bash
top-level HRC status command
top-level HRC event-stream command
server health alias
```

Replacement for agent/session/runtime monitoring:

```bash
hrc monitor show
hrc monitor watch
hrc monitor wait
```

Daemon lifecycle, daemon liveness, and backend diagnostics remain under `hrc server`:

```bash
hrc server start
hrc server serve
hrc server stop
hrc server restart
hrc server status
hrc server tmux status
hrc server tmux kill
```

Those commands own HRC daemon control and direct liveness checks. They do not own agent/session/turn monitoring.

The server health alias is not kept. Its behavior is consolidated into `hrc server status`.

### 3.2 Removed from `hrcchat`

```bash
status command in hrcchat
watch command in hrcchat
wait command in hrcchat
synchronous-DM wait flag in hrcchat
```

Replacement:

```bash
hrcchat dm --json cody@agent-spaces "..."
hrc monitor wait msg:<messageId> --until response-or-idle
hrc monitor watch msg:<messageId> --follow
```

`hrcchat` keeps message creation and message inspection:

```bash
hrcchat dm
hrcchat send
hrcchat show
hrcchat messages
hrcchat summon
hrcchat who
hrcchat peek
hrcchat doctor
hrcchat info
```

The split is intentional: `hrcchat` sends and reads messages; `hrc monitor` watches runtime, session, turn, and message completion state.

## 4. Added Surface

### 4.1 `hrc monitor show`

Snapshot command.

```bash
hrc monitor show [selector] [--json]
```

Without a selector, it prints HRC daemon health, socket state, event-log high-water mark, tmux backend state, runtime counts, and session counts.

With a selector, it prints the current snapshot for that selected object.

Examples:

```bash
hrc monitor show
hrc monitor show cody@agent-spaces
hrc monitor show session:<sessionRef>
hrc monitor show runtime:<runtimeId>
hrc monitor show msg:<messageId>
```

`show` is not history. It answers "what is true now?"

`hrc monitor show` includes daemon health when it can reach the daemon, but it is not the only liveness probe. Scripts and supervisors should use `hrc server status` for the direct "is the HRC daemon alive and responsive?" check.

### 4.1.1 Daemon liveness

Daemon liveness is a server-control concern, not an agent/session monitor concern.

```bash
hrc server status --json
```

Expected behavior:

- `hrc server status` exits `0` when the daemon process, socket, and API health check are healthy.
- `hrc server status` exits non-zero when the daemon is not running, the socket is missing/stale, or the API health check fails.
- `hrc server status --json` reports diagnostic state such as pid file, socket path, socket responsiveness, and tmux backend state.
- `hrc monitor show` may surface the same daemon health as part of a broader snapshot, but monitor commands should not be the only mechanism available to bootstrapping scripts, `stackctl`, or supervisors.

Suggested status exit codes:

| Code | Meaning |
| --- | --- |
| `0` | Healthy: daemon process exists, socket is responsive, and API health check passes. |
| `1` | Not running: no live daemon process or socket. |
| `2` | Degraded/stale: pid or socket exists, but the API health check does not pass. |
| `3` | Status probe failed due to local filesystem, permission, or unexpected diagnostic error. |

### 4.2 `hrc monitor watch`

Event stream command.

```bash
hrc monitor watch [selector] [--from-seq <seq>] [--follow] [--until <condition>] [--timeout <duration>] [--stall-after <duration>] [--json]
```

Without `--follow`, `watch` replays matching monitor events up to the current high-water mark and exits. This is the finite history/replay mode. There is no separate `hrc monitor history` command.

With `--follow`, `watch` replays the selected starting window, then stays attached to new events.

Examples:

```bash
hrc monitor watch cody@agent-spaces
hrc monitor watch cody@agent-spaces --follow
hrc monitor watch session:<sessionRef> --follow --until turn-finished
hrc monitor watch msg:<messageId> --follow --until response-or-idle
```

`watch` is for operators, logs, and Monitor-tool style consumption: one stdout line per event, line-buffered, with stable event names.

### 4.3 `hrc monitor wait`

Condition waiter command.

```bash
hrc monitor wait <selector> --until <condition> [--timeout <duration>] [--stall-after <duration>] [--json]
```

`wait` blocks until one condition is satisfied or the wait fails. It is the scripting primitive. It should emit a concise final event and exit with a meaningful code.

Examples:

```bash
hrc monitor wait cody@agent-spaces --until turn-finished
hrc monitor wait session:<sessionRef> --until turn-finished
hrc monitor wait msg:<messageId> --until response-or-idle --stall-after 10m
hrc monitor wait runtime:<runtimeId> --until idle --timeout 30m
```

`wait` is for scripts and caller agents that need a single answer. It is not a general event tail.

## 5. Selectors

All monitor subcommands accept the same selector grammar.

| Selector | Meaning |
| --- | --- |
| `cody@agent-spaces` | Target handle resolved through HRC session rules. |
| `cody@agent-spaces:T-01282~repair` | Full target handle with project, task/scope, and lane. |
| `scope:<scopeRef>` | HRC scope reference. |
| `session:<sessionRef>` | HRC session reference, including lane. |
| `host:<hostSessionId>` | Concrete host session. |
| `runtime:<runtimeId>` | Concrete runtime. |
| `msg:<messageId>` | Durable hrcchat message id. |
| `seq:<messageSeq>` | Durable hrcchat message sequence. |

Raw target handles are allowed because they are the normal human-facing HRC form. Explicit prefixes are preferred for IDs because they remove ambiguity and make scripts easier to read.

## 6. Conditions

`--until` accepts these conditions.

| Condition | Satisfied When |
| --- | --- |
| `turn-finished` | The active turn captured at monitor start reaches a terminal state. If no turn is active at monitor start, this is immediately satisfied with `result=no_active_turn`. |
| `idle` | The selected runtime/session is idle. If already idle at monitor start, this is immediately satisfied with `result=already_idle`. |
| `busy` | The selected runtime/session becomes busy. If already busy at monitor start, this is immediately satisfied with `result=already_busy`. |
| `response` | A response message correlated to the selected message/thread is observed. |
| `response-or-idle` | A correlated response is observed, or the selected turn becomes idle/finished without a response. Both are successful completions, distinguished by `result=response` or `result=idle_no_response`. |
| `runtime-dead` | The selected runtime is stopped, crashed, or otherwise no longer usable. If already dead at monitor start, this is immediately satisfied. |

### 6.1 Non-message turn monitoring

This is required.

```bash
hrc monitor watch cody@agent-spaces --follow --until turn-finished
hrc monitor watch scope:<scopeRef> --follow --until turn-finished
hrc monitor watch session:<sessionRef> --follow --until turn-finished

hrc monitor wait cody@agent-spaces --until turn-finished
hrc monitor wait scope:<scopeRef> --until turn-finished
hrc monitor wait session:<sessionRef> --until turn-finished
```

Both `watch --until turn-finished` and `wait --until turn-finished` take a start snapshot:

1. Resolve the selector to the current HRC session.
2. Capture the current `hostSessionId`, generation, runtime, and active turn/run id.
3. If no turn is active, exit immediately with code `0` and `result=no_active_turn`.
4. If a turn is active, wait for that exact captured turn/run to finish.
5. Do not chase future turns that start after the monitor begins.

If the session is cleared, rotated, or rebound before the captured turn finishes, the monitor exits non-zero with `result=context_changed`.

## 7. Exit Semantics

Exit codes are part of the API.

| Code | Meaning |
| --- | --- |
| `0` | Requested condition completed successfully, or a finite replay completed successfully. |
| `1` | Timeout or stall threshold reached before the requested condition completed. |
| `2` | Watched runtime/turn failed, crashed, or died before the requested condition completed. |
| `3` | HRC monitor infrastructure error: daemon unavailable, socket failure, corrupt cursor, event-log read failure. |
| `4` | The selected object reached a terminal state or generation change that makes the requested condition impossible, such as `--until response` with no response, or `turn-finished` after the watched session was cleared/rebound. |
| `64` | Invalid usage, invalid selector, missing required `--until`, or ambiguous selector. |
| `130` | Interrupted by the operator with SIGINT. |

### 7.1 `show` exit conditions

`hrc monitor show` exits:

- `0` after printing the requested snapshot.
- `3` if HRC cannot be reached or the snapshot cannot be read.
- `64` if the selector is invalid, missing, ambiguous, or does not resolve.

`show` never waits for a future state.

### 7.2 `watch` exit conditions

`hrc monitor watch` without `--follow` exits:

- `0` after replaying matching events through the current high-water mark, even if zero events matched.
- `3` on monitor infrastructure failure.
- `64` on invalid usage or selector errors.

`hrc monitor watch --follow` without `--until` exits:

- `130` when interrupted by the operator.
- `1` if `--stall-after` is supplied and no qualifying activity occurs before the stall threshold.
- `2` if the selected runtime/session dies in a way that ends the stream.
- `3` on monitor infrastructure failure.
- `64` on invalid usage or selector errors.

`hrc monitor watch --follow --until <condition>` exits:

- `0` when the condition is satisfied.
- `1` on timeout or stall.
- `2` if the watched runtime/turn fails before the condition can be satisfied.
- `3` on monitor infrastructure failure.
- `4` if the selected object reaches a terminal non-matching state.
- `64` on invalid usage or selector errors.

### 7.3 `wait` exit conditions

`hrc monitor wait <selector> --until turn-finished` exits:

- `0 result=no_active_turn` if no turn is in progress at monitor start.
- `0 result=turn_succeeded` when the captured turn finishes successfully.
- `1 result=timeout` or `result=stalled` when the configured timeout/stall threshold is reached.
- `2 result=turn_failed` or `result=runtime_dead` when the captured turn/runtime fails.
- `3 result=monitor_error` when HRC monitor infrastructure fails.
- `4 result=context_changed` when the selected session is cleared, rotated, or rebound before the captured turn finishes.
- `64` for invalid usage or selector errors.

`hrc monitor wait <selector> --until idle` exits:

- `0 result=already_idle` if idle at monitor start.
- `0 result=idle` when the selected runtime/session becomes idle.
- `1` on timeout or stall.
- `2` if the runtime dies before becoming idle.
- `3` on monitor infrastructure failure.
- `64` for invalid usage or selector errors.

`hrc monitor wait msg:<messageId> --until response` exits:

- `0 result=response` when a correlated response is observed.
- `1` on timeout or stall.
- `2` if the correlated runtime/turn fails before response.
- `3` on monitor infrastructure failure.
- `4 result=turn_finished_without_response` if the correlated turn reaches idle/finished without producing a response.
- `64` for invalid usage or selector errors.

`hrc monitor wait msg:<messageId> --until response-or-idle` exits:

- `0 result=response` when a correlated response is observed.
- `0 result=idle_no_response` when the correlated turn finishes or becomes idle without a response.
- `1` on timeout or stall.
- `2` if the correlated runtime/turn fails.
- `3` on monitor infrastructure failure.
- `64` for invalid usage or selector errors.

## 8. Watch vs Wait

`watch --follow` is an event stream.

Use it when the consumer wants every relevant event line:

```bash
hrc monitor watch cody@agent-spaces --follow
```

It keeps running until interrupted, until the stream fails, or until an optional `--until` condition is satisfied.

`wait` is a condition primitive.

Use it when the consumer wants one outcome and a reliable exit code:

```bash
hrc monitor wait cody@agent-spaces --until turn-finished
```

It exits as soon as the requested condition is resolved. If no turn is active for `turn-finished`, it exits immediately with success and `result=no_active_turn`.

## 9. Example: clod calls cody and monitors completion

The call is made with `hrcchat`, not `hrc`.

```bash
hrcchat --json dm cody@agent-spaces - <<'EOF'
Please review the branch and report completion.
EOF
```

The JSON response from `hrcchat dm` must include stable monitor handoff fields. `messageId`, `seq`, `to`, and `sessionRef` are required; `runtimeId` and `turnId` are included when known and can otherwise be resolved by `hrc monitor`.

```json
{
  "messageId": "msg_abc123",
  "seq": 741,
  "to": "cody@agent-spaces",
  "sessionRef": "agent:cody:project:agent-spaces/lane:main",
  "runtimeId": "rt_123",
  "turnId": "turn_456"
}
```

Then the caller monitors the message/turn:

```bash
hrc monitor wait msg:msg_abc123 --until response-or-idle --stall-after 10m --timeout 2h
```

If the caller does not care about the message and only wants to wait for the currently active turn in cody's session:

```bash
hrc monitor wait cody@agent-spaces --until turn-finished --timeout 2h
```

If cody has no active turn when this command starts, it exits immediately:

```text
monitor.completed selector=cody@agent-spaces condition=turn-finished result=no_active_turn
```

## 10. Output Contract

The monitor output must be friendly to both humans and agent Monitor tools.

- One stdout line per event.
- Line-buffered by default.
- Stable event names, for example `monitor.snapshot`, `turn.started`, `turn.finished`, `runtime.idle`, `runtime.crashed`, `message.response`, `monitor.completed`, `monitor.stalled`.
- Text mode may preview long message bodies.
- JSON mode must not truncate structured fields needed for automation.
- Replayed events include `replayed=true` in JSON and a text marker in text output.
- Every final exit should emit one final event before process exit when stdout is available.

Example text output:

```text
turn.started selector=cody@agent-spaces runtime=rt_123 turn=turn_456
runtime.idle selector=cody@agent-spaces runtime=rt_123 idle_for=2s
monitor.completed selector=cody@agent-spaces condition=turn-finished result=turn_succeeded
```

Example JSON output:

```json
{"event":"monitor.completed","selector":"cody@agent-spaces","condition":"turn-finished","result":"turn_succeeded","exitCode":0}
```

## 11. Implementation Notes

The HRC monitor implementation should join HRC's existing durable sources behind one CLI surface:

- daemon/socket health,
- tmux backend state,
- session resolution,
- host session generation,
- runtime state,
- active turn/run state,
- HRC event log,
- hrcchat durable message ids/sequences and response correlation.

The important implementation property is start-snapshot pinning. For `turn-finished`, HRC must capture the active turn at monitor start and wait for that exact turn. This avoids a monitor accidentally waiting forever because the original turn completed and a later unrelated turn began.

## 12. Deferred ACP Topics

All ACP-related monitoring is deferred until after the HRC monitor work is implemented.

Deferred topics:

- `acp monitor task <task-id>`
- `acp monitor dispatch <correlation-id>`
- `acp monitor agent <handle>`
- `acp message send --dispatch --monitor`
- ACP task stall semantics
- ACP dispatch correlation semantics
- ACP event projection endpoints
- Folding HRC runtime events into ACP task/dispatch monitors
- wrkq task lifecycle monitoring through ACP

The likely future shape is that ACP consumes HRC monitor events as an upstream source and adds task/control-plane semantics. That should be evaluated after HRC has a stable monitor contract and real usage.

## 13. Open Questions

1. What exact serialized form should HRC expose for `scopeRef` and `sessionRef` in CLI output?
2. Should `turn-finished` distinguish model/tool failure from process/runtime failure more granularly than exit code `2`?
3. What replay window should `hrc monitor watch` use by default when `--from-seq` is omitted?
4. Should `hrc monitor wait --until response-or-idle` require a message selector, or should it also work against a session selector by using the active turn correlation?
5. Should `context_changed` remain exit code `4`, or should generation changes get their own dedicated code?

## 14. Review History

- 2026-04-27: Initial ACP/HRC proposal drafted after Phase 6 coordination failures.
- 2026-04-27: Revised to focus on HRC first, remove legacy status/watch/wait duplication, reject legacy aliases, add non-message turn monitoring, and defer ACP topics.
- 2026-04-27: Cody architecture review locked Q1-Q5 contracts (see §15.2). Implementation kicked off via clod-coordinated multi-agent dispatch.

## 15. Implementation Status (snapshot 2026-04-27, mid-session)

This section captures the state of the implementation effort so a new session can resume cleanly. Below: completed phases with commit SHAs, open hot-fix tasks, known remaining bugs, and the next-step playbook. The original spec sections §1-§13 above remain authoritative; this section is a status appendix only.

### 15.1 Project, conventions, dispatch model

- **Project:** `agent-spaces` (P-00002). All wrkq tasks live in `agent-spaces/inbox`.
- **Coordinator:** clod, driving via the `clod-agent:agent-tasker` skill.
- **Roster used:** smokey (red-test author + smoke gatekeeper), cody (root-cause + complex impl), larry (scoped impl), curly (CLI/refactor impl).
- **Dispatch handle:** every wrkq task gets a per-task scoped session — `<agent>@agent-spaces:T-XXXXX`. Memory rules: never reuse a session across wrkq tasks; bare-handle DMs hit the wrong session.
- **Test-then-impl pattern (folded):** each phase task is owned by one implementer who DMs smokey first for red acceptance tests, then implements to green. Smokey commits red, implementer commits green.
- **Cli-kit exit code override:** the original §7 proposal uses exit `64` for usage errors; we override to exit `2` to align with cli-kit convention (no platform-wide migration this round).

### 15.2 Frozen Q1-Q5 contracts (from cody architecture review)

- **Q1 (selector serialization):** JSON output exposes canonical `scopeRef="agent:<id>:project:<id>:task:<id>"` + `sessionRef="<scopeRef>/lane:<id>"` as primary; also include `scopeHandle`/`sessionHandle` for display. Text mode prefers handles; JSON includes both.
- **Q2 (failure discrimination):** keep exit `2` for failure; final event includes `result=turn_failed|runtime_dead|runtime_crashed` + `failureKind=model|tool|process|runtime|cancelled|unknown` discriminators.
- **Q3 (replay window):** non-follow `watch` defaults to last 100 matching events; `--follow` defaults to current high-water + initial `monitor.snapshot`.
- **Q4 (selector restrictions):** `response`/`response-or-idle` REQUIRE a `msg:` selector. Session selectors are rejected at the engine boundary.
- **Q5 (context_changed):** keeps exit `4`, includes `result=context_changed` + `reason=session_rebound|generation_changed|cleared` discriminators.

### 15.3 Completed phases

| Phase | Description | Owner | wrkq | Commit |
|---|---|---|---|---|
| F0 | Selector grammar parser + canonical serialization (`packages/hrc-core/src/selectors.ts`) | cody | T-01285 | `80e2f0d` |
| F1a | Resolver + snapshot reader + event-source w/ atomic capture (`packages/hrc-core/src/monitor/index.ts`) | larry | T-01286 | `0f80e74` |
| F1b | Shared wait/watch condition engine (`packages/hrc-core/src/monitor/condition-engine.ts`) | cody | T-01288 | `99ae5ac` |
| F1c | Monitor event/result schema + harness normalization audit (`packages/hrc-events/src/monitor-schema.ts`, `packages/hrc-events/MONITOR_HARNESS_AUDIT.md`) | curly | T-01287 | `015e4d8` (+ `dbf91e3` regex fix) |
| F2a | `hrc monitor show [selector] [--json]` (`packages/hrc-cli/src/monitor-show.ts`) | larry | T-01289 | `3689182` |
| F2b | `hrc monitor watch [...]` (`packages/hrc-cli/src/monitor-watch.ts`) | curly | T-01290 | `b1c8a75` |
| F2c | `hrc monitor wait <selector> --until <condition>` (`packages/hrc-cli/src/monitor-wait.ts`) | cody | T-01291 | `97dae6d` |
| F2d | `hrc server status` consolidation + cli-kit exit codes (`packages/hrc-cli/src/cli.ts`, `cli-runtime.ts`) | larry | T-01292 | `18651f3` |
| F2e | `hrcchat dm --json` handoff envelope + durable correlation join (`packages/hrcchat-cli/src/commands/dm.ts`, `packages/hrc-server/src/index.ts`) | curly | T-01293 | `ae5bb96` |
| Hot-fix | Multi-generation resolver: prefer latest active gen for target lookup; correlation join captures live gen at message-create time (`packages/hrc-core/src/monitor/index.ts`, `packages/hrc-server/src/index.ts`) | cody | T-01295 | `e4ed9ea` |
| Hot-fix | Polling condition reader for `monitor watch --follow --until <condition>` with deadlines (`packages/hrc-cli/src/monitor-watch.ts`) | curly | T-01297 | `60a32f7` |
| Hot-fix | `hrcchat dm --json` populates `runtimeId` for already-summoned targets (`packages/hrc-server/src/index.ts`, `packages/hrcchat-cli/src/__tests__/smoke.test.ts`) | curly (committed by clod) | T-01298 | `89c7908` |
| F3pre | Pre-removal repo-wide audit doc + live smoke gate (`packages/hrc-cli/MONITOR_REMOVAL_AUDIT.md`) | smokey | T-01294 | `d2761c7` audit + `9351f69` final green re-smoke |
| Hot-fix | Condition engine ready-idle short-circuit + msg-response reply correlation (`packages/hrc-core/src/monitor/condition-engine.ts`, `packages/hrc-core/src/monitor/index.ts`, `packages/hrc-cli/src/monitor-watch.ts`, `packages/hrc-cli/src/monitor-wait.ts`) | cody (red by smokey) | T-01299 | `7550245` red + `38edf23` green |
| F3 | Legacy command removal (hrc status/events/server health, hrcchat status/watch/wait/dm --wait, test + doc + script migration) | cody | T-01300 | `70ab540` |
| F4 | Clod-driven e2e live smoke against canonical paths; F4 evidence appended to audit doc | clod | (post-task) | `a132d78` |
| Hot-fix | `hrcchat dm --json` envelope written as compact single-line JSON via `printJsonLine` (`packages/hrcchat-cli/src/commands/dm.ts`, `packages/hrcchat-cli/src/print.ts`) | cody (red by smokey) | T-01301 | `9bf069b` red + `73bbc32` green |

Note on T-01298 closure: curly's runtime was killed at 17:23:55 by an attempted `hrc server restart` from inside curly's own session. Fix files were preserved in the working tree and verified by 20/0 hrcchat-cli + 257/0 hrc-server tests. Coordinator (clod) committed and closed on curly's behalf with attribution in the commit message.

### 15.4 Open wrkq tasks

None. All migration tasks (T-01294, T-01295, T-01296, T-01297, T-01298, T-01299, T-01300, T-01301) are completed.

### 15.5 Known remaining bugs

None known. T-01301 (the only outstanding defect surfaced during F4) was fixed via `73bbc32`. Independent verification: 50/50 multi-line body dispatches parse cleanly via `jq -e .` after the fix.

The actual fix differed from the original hypothesis. The defect was not multiple write paths concatenating raw text — it was that the shared `printJson` helper was using `JSON.stringify(value, null, 2)` (pretty-printed with indent), so the envelope spanned multiple lines and stream consumers (jq) would read partial JSON when scripts captured via shell command substitution. Multiline bodies aggravated the symptom because the body's literal LFs landed inside the pretty-printed body string. Fix: route `dm --json` through a new `printJsonLine` helper that uses compact `JSON.stringify(value)`, producing one strict JSON value per dispatch.

### 15.6 Next-step playbook

Migration is fully closed. ACP monitoring topics (deferred per §12) become eligible for evaluation.

### 15.7 Dispatch hygiene notes (lessons learned this session)

- **Never have a dispatched agent restart hrc-server.** It kills every active session including the agent itself. Coordinator owns hrc lifecycle. (One agent did this and lost their session; clod committed on their behalf.)
- **Sibling reds in the wider package suite are NOT a closure gate** for parallel-wave assignees. Tell each assignee explicitly: "verify YOUR files only; sibling tests in flight are out of scope." (Several Wave-3 implementers initially blocked on this.)
- **Closure checklist must include 'COMMIT before close'.** Several agents in early waves closed wrkq tasks with uncommitted impl in the working tree. Adding an explicit commit step in the dispatch DM resolved this in later waves.
- **DM response correlation timeout is routine during the historical flow.** Treat the `failed` task notification as noise for `run_in_background` dispatches; verify via `hrcchat messages` and `wrkq cat T-XXXXX`.
- **Live smoke against a busy coordinator self-deadlocks.** When the coordinator is also the smoke target for `--until idle` / `--until turn-finished` / `response-or-idle`, conditions can never satisfy. Use a third-party idle target (e.g. `agent-minder@agent-spaces`).
