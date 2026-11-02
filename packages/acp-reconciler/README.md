# acp-reconciler

Starts delegated work and reports stalls. This page describes the implementation.
The completed intent and design proposal are task attachments ATT-00407 and
ATT-00408 on T-09980 (delegated sessions reconciler package); retrieve them with
`wrkq attach get <attachment-id>`. The
[as-built lifecycle diagram](../../docs/proposals/acp-reconciler-design/delegated-request-lifecycle.png)
also has an [editable source](../../docs/proposals/acp-reconciler-design/delegated-request-lifecycle.arris.json).

A task or subtask carrying `ext acp/request/main { rev: <positive integer> }`
is a delegated request. During migration, scans union extension discovery with
legacy meta markers. The extension wins whenever it exists; only a `not_found`
read permits `meta.acp.request` as fallback. Both lists are paginated and the
extension list filters unfinished subject states. Every scan reads current wrkq
and HRC state. There is no controller database or persistent cursor. Each scan:

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

## Request-marker migration maintenance

ACP hosts two fixed operations on the **same cached WorkClient object** supplied
to its normal reconciler:

| Method and route | Exact JSON body | Result |
| --- | --- | --- |
| `POST /v1/admin/reconciler/acp-request-backfill/plan` | `{}` | Read-only, full historical census and review manifest |
| `POST /v1/admin/reconciler/acp-request-backfill/apply` | `{ "manifest": <reviewed object>, "expectedSha256": "<digest>" }` | Bounded application of only the reviewed subjects |

These are trusted host-local operator operations. Admission requires an observed
loopback socket peer, no `Origin` header, JSON content type and exact body shape.
Unknown and remote peers refuse; forwarded, Host and actor headers establish no
authority. Locality does **not** authenticate Mable or an HRC task. Campaign policy
separately restricts invocation to Mable and requires explicit release of the
operation and exact apply manifest. Source delivery or route availability grants
no install, activation, live plan or apply permission.

The host fixes the producer to its configured `agent:acp-reconciler`, binds the
startup database locator, and checks current HRC node authority against the
designated reconciler node before owner reads or writes. Disabled/unavailable
reconciler capability, wrong principal or node refuses. The caller cannot select
an actor, client, locator, script, namespace or arbitrary write. The standalone
`scripts/acp-request-backfill.ts` wrapper shares the algorithm, but a task shell
selecting a literal principal is not evidence of service execution.

Plan follows every task cursor across all states, deleted subjects and named
subtasks. It skips unrelated ACP metadata and refuses malformed actual request
markers. Apply checks the reviewed digest, locator, UUIDs and task/extension
fences before any write and again at each acting point. It reconciles
`max(metaRev, extRev)` using extension CAS and emits keyed `ext.backfill` facts
(`backfill:<T>:acp/request`) with string `meta_rev`, `ext_rev`, `written` attrs.
It changes no task metadata, claims or worker lifecycle.

Only one maintenance operation runs at a time; busy refuses without queuing.
Errors stop work. A lost reply or disconnect leaves effects uncertain: inspect
owner state, retain the original manifest/digest, then explicitly reconcile that
same manifest after authorization. Exact expected post-put state and keyed facts
support recovery and zero-write/zero-new-fact replay. There is no automatic retry,
rollback promise or cancellation of the shared client on HTTP disconnect.

HTTP replies and `request_backfill.receipt` logs carry request correlation, host
instance UUID/PID, times, node, startup locator, producer, manifest digest, counts
and returned fact IDs or partial acknowledged progress. Consumed host/routine
SHA256 values are captured from module bytes at load, **not** inferred from the
checkout's current HEAD; the activating operator must map them to the delivered
source/build. Null service HRC scope is not replaced with a fabricated task scope.
Installed host/client provenance, live plan/apply and rerun acceptance remain
separate operator gates. See the
[host authority contract](../../architecture/contracts/reconciler-request-backfill-host.yaml).

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
