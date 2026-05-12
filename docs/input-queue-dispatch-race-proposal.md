# Input queue dispatch race — fix proposal

## Context for retracing

**Where this came from**: heather (the vitals agent) running on the `mini` host failed a Discord-originated input on `2026-05-12T00:08:38Z` with `errorCode: dispatch_timeout`, message `Run was blocking input queue dispatch with partial HRC session correlation but no turn/runtime correlation within 45s`. Discord rendered it as `⚠️ ACP run run_de6fa317362f ended as failed: ...`.

**Environment**: `mini` is one major version behind `max3`. ACP source on `mini` is `lherron@mini:~/praesidium/agent-spaces`, latest commit `6ad8706 Release v0.5.7` on `main`. HRC and ACP run as launchd user agents (`com.praesidium.{hrc,acp}-server`) on `mini`. Logs at `~/praesidium/var/logs/`. HRC state at `~/praesidium/var/state/hrc/state.sqlite`. SDK debug at `~/.claude/debug/`. CC session JSONLs at `~/.claude/projects/-Users-lherron-praesidium-vitals/`.

**Specific identifiers from the incident** (for future-grep):
- ACP run: `run_de6fa317362f`
- Heather host session (gen 6): `hsid-123cc281-181d-4ebf-ad1d-565fa4005b61`
- SDK session: `d5830acb-2957-4962-90bf-315fc8843a5b`
- Scope: `agent:heather:project:vitals` / lane `main`
- Conversation: Discord channel for #heather

**Reproduce / verify**: send two Discord messages to heather <2s apart while she's mid-turn on a >45s response. Without the fix, the second one becomes a fallback queued run (`metadata.contributionFallback: true`) and gets killed at 45s with `dispatch_timeout`. After the fix lands, the second one parks behind the first cleanly and dispatches when the first turn completes.

## What the user sees

A `⚠️` reply from the agent's webhook persona instead of a real answer. The message is technically correct ("run failed, 45s, no correlation"), but the underlying agent was healthy — the input was *throttled by ACP itself*, not refused by HRC or the model. Operators looking at this in isolation will (and did) suspect the agent is broken; the actual failure is in the dispatcher.

## Why this affects more than heather

The bug surfaces on any agent whose turns exceed ~40s when a second input arrives during the first turn. Heather hit it first because the vitals workflow makes back-to-back inputs likely (Lance logging meals as he eats them). But the dispatch code path is shared and non-SDK runtimes (clod, cody, supervisor, ariadne) are equally exposed — see D4 below. Any tmux/headless agent with a long turn + a follow-up message will hit this exact race.

## The mechanics

Call site is `packages/acp-server/src/integration/input-queue-dispatcher.ts:238`:

```ts
function sameSessionHasActiveRun(deps, item) {
  const sessionRef = normalizeSessionRef({...})
  failStalePendingRunBlockers(deps, item)         // ← cleanup runs inside the check
  return deps.runStore.listRunsForSession(sessionRef).some(
    (run) => run.runId !== item.runId && (run.status === 'pending' || run.status === 'running')
  )
}
```

Four related defects compound:

### D1 — Stale classifier can't distinguish "broken launch" from "parked behind sibling turn"

`classifyStalePendingRunBlocker` (line 56) flags any pending run whose `hostSessionId` is set, `hrcRunId/runtimeId` are absent, and `now - updatedAt > 45s`. It treats two situations identically:

- HRC accepted the launch but never assigned a runtime (genuinely stuck — should die)
- HRC accepted the launch and parked it behind another active turn on the same host session (legitimately waiting — should live)

### D2 — `updatedAt` freezes while a run is parked

ACP records `hostSessionId` once at admission and never refreshes the timestamp afterward. The 45s clock therefore counts from the moment of HRC-park, not from when the run actually becomes the head of the dispatch queue. Any prior turn that takes >45s wall-clock makes the parked run look stale to the classifier.

### D3 — Cleanup is wired inside the dispatch decision

`failStalePendingRunBlockers` is called from inside `sameSessionHasActiveRun`. Every queue tick that asks "may I dispatch?" also reaps. There is no separate maintenance pass; the executioner runs on the hot path. Result: the moment the next input arrives, the *previous* parked run is at risk of being killed — even if it would have dispatched moments later.

### D4 — The HRC contribution gate forces non-SDK runtimes through the fallback path unconditionally

`packages/hrc-server/src/index.ts:2549`:

```ts
if (
  process.env['HRC_ACTIVE_RUN_CONTRIBUTIONS_ENABLED'] === '1' &&
  runtime.transport === 'sdk' &&
  runtime.supportsInflightInput
)
```

For every tmux/headless runtime (clod, cody, supervisor, ariadne), the `transport === 'sdk'` clause fails regardless of the env var. HRC returns `active_run_contribution_disabled`. ACP runs `createQueuedContributionFallback`, manufacturing a queued run that immediately enters the racing path described above. The contribution rejection is also the only thing the request did — pure round-trip cost, no signal value.

For SDK runtimes (e.g., heather, when `HRC_ACTIVE_RUN_CONTRIBUTIONS_ENABLED=1` is set), the contribution lands cleanly and no fallback run is created. So flipping that env var saves SDK agents but leaves non-SDK agents exposed.

## Incident timeline (`run_de6fa317362f`)

| Time (UTC)     | Event                                                                                     |
|----------------|-------------------------------------------------------------------------------------------|
| 00:08:22       | R1 "Raising canes chicken tenders, 2" dispatched; heather working                          |
| 00:08:38       | R2 "3/4 oz canes sauce" — contribution rejected, fallback run created (`status=queued`)    |
| 00:08:~40      | Dispatcher dispatches R2; HRC accepts and parks behind R1; ACP writes `hostSessionId`     |
| 00:08:40       | R1 completes                                                                              |
| 00:09:28       | Dispatcher tick re-evaluates R2: `updatedAt` 48s old → stale blocker → `dispatch_timeout` |
| 00:09:31       | Lance "Hi" arrives — new R3, dispatches cleanly into the freshly-cleared session          |
| 00:31:04       | Lance retries "1/2 oz canes sauce" — R4 succeeds                                          |

Heather was healthy throughout (her SDK session `d5830acb` shows R4's reasoning landed correctly: "half cup ≈ 0.75 oz, ~95 cal"). The system killed R2 ~10s after R1 finished, just before HRC would have assigned R2 a runtime.

## Recommendations

### #1 — Don't classify "waiting behind sibling" as stale

Smallest behavioral fix. `classifyStalePendingRunBlocker` should return `undefined` when the same `(scopeRef, laneRef)` has any other run in `running` state, or any other run with a complete `hrcRunId`+`runtimeId` correlation.

```ts
function classifyStalePendingRunBlocker(
  run: StoredRun,
  timeoutMs: number,
  siblings: ReadonlyArray<StoredRun>,
): StaleBlockerKind | undefined {
  // ...existing guards...
  const hasActiveSibling = siblings.some(
    (s) =>
      s.runId !== run.runId &&
      (s.status === 'running' ||
        (s.status === 'pending' && s.hrcRunId !== undefined && s.runtimeId !== undefined))
  )
  if (hasActiveSibling) return undefined
  return run.hostSessionId === undefined ? 'no_correlation' : 'partial_correlation'
}
```

Call sites pass the existing `listRunsForSession(sessionRef)` result.

**Tests**: existing dispatcher unit tests with new fixtures —
- (a) parked run + active sibling does *not* fail
- (b) parked run + idle session DOES fail after timeout
- (c) classifier still fires for genuinely stuck launches

### #2 — Refresh `updatedAt` for parked runs

Belt-and-braces for #1. Two options, pick one:

- **(a)** When ACP receives an HRC park acknowledgment (the response that returns `hostSessionId` but no `hrcRunId`), update the run via `runStore.updateRun(runId, {status: 'pending'})` — even a no-op-field update bumps `updatedAt`.
- **(b)** Add a heartbeat pass: every `intervalMs`, the dispatcher touches `updatedAt` on parked runs whose session is busy with a sibling. This keeps the staleness signal meaningful (it now means "ACP itself stopped tracking this run," not "HRC has been slow").

Prefer (a) — cheaper, no new tick.

**Tests**: assert `updatedAt` advances when HRC returns a park response; assert `updatedAt` does not advance after terminal HRC events.

### #3 — Separate "may I dispatch?" from "is anything stale?"

Move `failStalePendingRunBlockers` out of `sameSessionHasActiveRun`. Run it from the dispatcher main loop on its own cadence (every `intervalMs * N`, e.g. every 5 ticks). The dispatch decision becomes pure: "are there other active runs on this session?" — no side-effects, no surprise reaping.

```ts
// dispatcher.runOnce()
maybeRunStaleSweep(deps)               // bounded; only fires every N ticks
for (const item of pending) {
  await dispatchItem(item)             // sameSessionHasActiveRun is now read-only
}
```

**Tests**: assert `sameSessionHasActiveRun` no longer mutates state (call it twice in succession, observe no run-store updates); assert stale sweep still fires within bounded latency.

### #4 — Drop the HRC contribution rejection for non-SDK; accept-and-queue at the boundary

Replace the `else { rejected: 'active_run_contribution_disabled' }` branch at `hrc-server/src/index.ts:2616` with a path that hands the input back to ACP as `status: 'queue_recommended'`, plus the runtime descriptor (`transport`, `supportsInflightInput`) so ACP can decide whether to retry contribution on a different runtime generation or just enqueue. ACP's existing `createQueuedContributionFallback` becomes the *only* path for non-SDK queue admission rather than a rejection-handler.

```ts
} else {
  response = {
    status: 'queue_recommended',
    inputApplicationId: body.inputApplicationId,
    hostSessionId: runtime.hostSessionId,
    generation: runtime.generation,
    runtimeId: runtime.runtimeId,
    runId: runtime.activeRunId,
    capability: {
      supported: false,
      reason: !contributionsEnabledEnv
        ? 'feature_disabled'
        : runtime.transport !== 'sdk'
          ? 'transport_unsupported'
          : 'inflight_unsupported',
    },
  }
}
```

ACP-side: `submitActiveRunContribution` callers treat `queue_recommended` like a rejection (still routes to the fallback) but stop logging it as an error. The HRC log entry disappears too. Cosmetic + structural — same observable behavior, cleaner semantics, easier to evolve later when more transports gain in-flight input.

**Tests**: HRC integration test — non-SDK runtime returns `queue_recommended` not `rejected`; ACP unit test — `queue_recommended` response triggers the same fallback path as a rejection but emits no error log.

## Priority

`#1` and `#2` together close the production hazard. `#3` is hygiene that makes `#1` testable in isolation. `#4` is structural and should land last — it's not a fix, it's a cleanup.

## Already done on `mini` (2026-05-12)

Operational mitigations applied while the code fix is pending:

1. **Bumped** `ACP_INPUT_QUEUE_STALE_PENDING_RUN_TIMEOUT_MS` (already done by max3 op separately; mini left at default for now per Lance — revisit if the race recurs before the code fix lands).
2. **Flipped** `HRC_ACTIVE_RUN_CONTRIBUTIONS_ENABLED=1` in `~/Library/LaunchAgents/com.praesidium.hrc-server.plist` so heather (SDK transport) bypasses the fallback path entirely. Non-SDK agents on mini are still exposed until the code fix lands.
3. **Cleaned up** zombie gen-6 heather runtimes (11 entries stuck in `status=ready` with no wrapper/child PIDs).

The flipped env var is durable across launchd reloads but will need to be re-applied if the plist is regenerated by `stackctl init` or similar.
