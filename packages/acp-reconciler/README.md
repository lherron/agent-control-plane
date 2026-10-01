# acp-reconciler

Starts delegated work and reports stalls. Spec:
[docs/proposals/acp-reconciler-proposal.md](../../docs/proposals/acp-reconciler-proposal.md).

A task or subtask carrying `meta.acp.request: { rev: <positive integer> }` is a
delegated request. Every scan reads current wrkq and HRC state. There is no
controller database and no cursor. Each scan:

1. Starts each `open`, unclaimed request assigned to a valid `agent:<id>`, while
   capacity allows. Before dispatch it reserves the start with a keyed
   `delegation.started` fact on the request:
   - key: `recon:<requestId>:<rev>:<agent>@<project>:<requestId>`
   - attributes: `requester`, `assignee_seat`, `rev` and `start_key`

   A replayed key (`created: false`, or the losing side of a unique-index race)
   means another scan or copy owns the start, and nothing is dispatched. HRC
   then summons the worker seat with `birthCause: 'assignment'` and queues the
   assignment turn, using the start key as the enqueue idempotency key.
2. Reports three stalls, each as one `delegation.stalled` fact plus one `--fyi`
   notice per episode, keyed `stall:<requestId>:<kind>:<episode>`. The notice
   goes to `requesterScopeRef`, falling back to the scope-less
   `requesterPrincipalRef`:
   - `ended_holder`: a claim held on unfinished work whose seat's HRC runtimes
     have all ended. Episode: the claim generation.
   - `unclaimed_reservation`: a current reservation still unclaimed after the
     claim window. Episode: the start key.
   - `orphaned_in_progress`: `in_progress`, unclaimed, with no current
     reservation, past the claim window since the last update. Episode: the
     claim generation.

The reconciler never releases, retries or fails work. It sends no completion
notices, and workers never message it.

## Host and configuration

`acp-server` constructs the reconciler and starts or stops it with its own
lifecycle. All logic lives here. Configuration:

| Variable | Default | Meaning |
| --- | --- | --- |
| `ACP_RECONCILER_NODE` | unset | Designated HRC node id. Unset: not constructed. Another node: idle. |
| `ACP_RECONCILER_INTERVAL_MS` | 45000 | Scan interval, 30000–60000 |
| `ACP_RECONCILER_GLOBAL_CAPACITY` | 4 | Active claims plus current reservations, all agents |
| `ACP_RECONCILER_AGENT_CAPACITY` | 2 | The same count, per agent |
| `ACP_RECONCILER_CLAIM_WINDOW_MS` | 600000 | Claim window for both unclaimed stall rules |
| `ACP_RECONCILER_PRINCIPAL` | `agent:acp-reconciler` | Principal for facts, notices and HRC origin |

Unknown or malformed `ACP_RECONCILER_*` values refuse startup. The log records
decision changes only: a request that is newly startable, reserved,
dispatched, stalled, or has an invalid marker or assignee. Steady waiting
states are not logged on every scan. The baseline lives in memory, so after
a restart each standing start, stall or invalid decision is logged once again.
That line is a log line only: facts and notices stay exactly once per episode.
A scan that fails, for example on a wrkq timeout, is retried on the next tick.
Its failure is logged once until the message changes, followed by one
`scans recovered` line.
A human assignee is an `agent:<id>` with no agent home; HRC resolution finds
none, so explain shows it as not startable, and it is never started.
An agent whose profile declares `[placement] launch = "participant-only"` is
also not startable. It is read from the same HRC placement resolution, so it is
never reserved. When a dispatch fails after its reservation, explain shows
`reserved; dispatch failed: <reason>` from this instance's record. A separate
process, such as the explain CLI, derives `reserved; no HRC session for the
seat` from HRC instead. Both are explain-only; the unclaimed-reservation stall
remains the durable report.

## Explain

```bash
acp-reconciler explain [<task-id>] [--json]
```

Runs the reconciler's own evaluation over live state and prints why each
request starts, waits, is active, invalid or stalled, with its start key,
reservation time and stall evidence. It is read-only. It receives only the
read half of each port and writes nothing, not even a reservation probe.

## Known limits

- **Cross-node holders are never "ended".** HRC only reports runtimes on its own
  node. A claim whose `claimedNode` is not this node, or whose seat has no HRC
  runtime rows here, reads as unknown, so the ended-holder rule never fires for
  it. Federated liveness is follow-on work.
- **A busy seat can raise a false unclaimed-reservation stall.** An assignment
  queued behind a long turn in an existing seat may not be claimed within the
  window. The resulting stall is only a report; nothing is released or retried.
- **Capacity is soft across copies.** An accidental second copy evaluates
  capacity independently and can admit up to its own limit again. Start
  uniqueness is the correctness guarantee.
