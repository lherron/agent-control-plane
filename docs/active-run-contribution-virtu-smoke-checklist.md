# Active-Run Contribution Virtu Smoke Checklist

Task: T-01381, parent T-01379.

Use this checklist for the AgentSpaces SDK provider contribution real smoke. The feature flag must be enabled only for the HRC process used by these cases, except the explicit feature-flag-off case.

## Preconditions

- Branch: `feat-input-admission`.
- Refresh installed binaries: `just install`.
- Restart services after binary refresh:
  - `hrc server restart`
  - `launchctl kickstart -k gui/$(id -u)/com.praesidium.acp-server`
- Confirm health: `stackctl status dev --brief` shows HRC and ACP healthy.
- Use gateway `acp-discord-smoke` and channel `channel:1501224513390772224`.
- Bind the channel to a fresh task-scoped session, for example:

```bash
acp admin interface binding set \
  --gateway acp-discord-smoke \
  --conversation-ref channel:1501224513390772224 \
  --project agent-spaces \
  --scope-ref agent:cody:project:agent-spaces:task:steering-tb-smoke-$(date +%H%M%S) \
  --lane-ref main \
  --json
```

## Evidence To Record

- Exact commands used, including `acp send` and `./scripts/virtu-send.sh`.
- Exact ACP response JSON for every input.
- HRC ledger query result for each contribution:

```bash
curl -sS http://127.0.0.1:18470/v1/active-run-contributions/<inputApplicationId> | jq .
```

- Discord message order observed from the real channel.
- Service restart timestamps and `just install` confirmation.

## Case 1: accepted_in_flight

With `HRC_ACTIVE_RUN_CONTRIBUTIONS_ENABLED=1` in the HRC server environment, start a long-running AgentSpaces SDK run. While it is in flight:

```bash
acp send \
  --scope-ref <scopeRef> \
  --lane-ref main \
  --intent contribute \
  --contribution-fallback reject \
  --idempotency-key steering-tb-accepted-1 \
  "contribution accepted_in_flight smoke"
```

Expected:

- ACP response has `admission.kind == "accepted_in_flight"`.
- ACP `currentState.applicationStatus == "accepted"`.
- HRC ledger row is `status == "accepted"`.
- Capability reports `deliverySemantics == "sequential_followup"` and `ackSemantics == "accepted_only"`.
- Discord shows the contribution as a later assistant follow-up, not same-turn injection.

## Case 2: duplicate idempotency

Replay Case 1 with the same idempotency key while the original run remains in flight.

Expected:

- ACP returns the original immutable admission.
- HRC ledger has exactly one accepted row for the `inputApplicationId`.
- AgentSpaces SDK does not enqueue a second provider prompt for the same `inputApplicationId`.

## Case 3: FIFO With Mixed Ordinary And Contribute

While a run is busy, send two ordinary inputs, then one contribution, then one ordinary input:

```bash
acp send --scope-ref <scopeRef> --lane-ref main --idempotency-key steering-tb-fifo-1 "ordinary one"
acp send --scope-ref <scopeRef> --lane-ref main --idempotency-key steering-tb-fifo-2 "ordinary two"
acp send --scope-ref <scopeRef> --lane-ref main --intent contribute --contribution-fallback reject --idempotency-key steering-tb-fifo-c "contribution"
acp send --scope-ref <scopeRef> --lane-ref main --idempotency-key steering-tb-fifo-3 "ordinary three"
```

Expected:

- Ordinary inputs return `queued_run` with consecutive FIFO sequence values.
- Contribution returns `accepted_in_flight` and does not consume a queued-run sequence.
- The third ordinary input gets the next queued-run sequence.
- Discord drains ordinary queued runs in FIFO order.

## Case 4: busy default queue regression

While a run is busy, send two ordinary inputs without `--intent`.

Expected:

- Both return `queued_run`.
- Both drain in FIFO order.
- No ordinary input is treated as an active-run contribution.

## Case 5: feature flag off

Unset `HRC_ACTIVE_RUN_CONTRIBUTIONS_ENABLED`, restart HRC, and repeat Case 1 twice:

```bash
acp send \
  --scope-ref <scopeRef> \
  --lane-ref main \
  --intent contribute \
  --contribution-fallback reject \
  --idempotency-key steering-tb-flag-off-reject \
  "flag off reject"

acp send \
  --scope-ref <scopeRef> \
  --lane-ref main \
  --intent contribute \
  --contribution-fallback queue \
  --idempotency-key steering-tb-flag-off-queue \
  "flag off queue"
```

Expected:

- Reject fallback returns `admission.kind == "rejected"` with reason `active_run_contribution_disabled`.
- Queue fallback returns `admission.kind == "queued_run"` with reason `active_run_contribution_disabled`.
- HRC ledger shows rejected rows with `errorCode == "active_run_contribution_disabled"`.

## Cleanup

Restore the smoke channel binding to its prior project/scope with `acp admin interface binding set ...`. Record the restored binding JSON in the task comment.
