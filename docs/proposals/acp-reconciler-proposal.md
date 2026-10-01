# ACP reconciler: delegated sessions

**Product decisions settled with Lance; implementation design revised after
Daedalus's reviews (REJECT, EN-21829, EN-21832, EN-21835 and EN-21839) and resubmitted.** Cody and Mable's peer revision, October 1, 2026. The goal is recorded in
[Delegated work and session context isolation](acp-delegated-work-intent.md).

The requester records a concern as a task or subtask and goes back to its work.
The reconciler starts the assigned specialist in a separate session and reports
stalls; the specialist records its result and tells the requester. The specialist loads its own skills,
tools and working context. Cross-agent conversation stays available throughout.

**Record request → wait until ready → start specialist → record result.**

A small `delegate` skill selects an existing agent from a hand-maintained roster.
From a task seat, it creates `T-owner.<slug>` under that task, using its owner if
the seat itself names a subtask. Otherwise it creates the request itself as a
top-level inbox task. The description holds the brief, source references and
expected result. The requester need not know the specialist's skills; the worker
chooses them from its own ASP space. No message or seat birth is required from
the requester. Create the complete request, including its marker and
identities, in one call so its creation is visible as requested work. Tasks and
subtasks carrying `meta.acp.request` are scheduled:

```json
{ "acp": { "request": { "rev": 1 } } }
```

Wrkq exposes three first-class facts on ordinary tasks and subtasks:

| Fact | Representation |
| --- | --- |
| Who requested it | New nullable `requesterPrincipalRef` and `requesterScopeRef`, set by the helper and editable like assignee |
| Who should do it | Existing `assigneePrincipalRef`; for `agent:<id>`, derive `<agent>@<project>:<taskOrSubtaskId>` |
| Who holds it now | Existing claim principal, scope, node, time and generation |

Creator attribution remains audit history. The owner view shows these facts for
itself and its subtasks, including all workers with unfinished claimed work.
Reuse existing task show/list reads, including `task.list(subtaskOwner)`; no
participant registry. Expose the already-emitted `task.claimed` and
`task.claim_released` in the existing `wrkp` timeline, visible by default. In the
same change, make `task.created` visible by default for subtasks and request tasks,
including their requester fields. `wrkp log --task <owner>` includes the whole
subtask family. HRC session facts provide observed liveness; no fact means
unknown, not dead. A live session with a
claim means the worker holds the work and is alive, not necessarily computing.

The reconciler is a new package, `packages/acp-reconciler`. It owns the scan,
readiness, start, stall and stall-notice logic and its wrkq, wrkp and HRC client
seams. `acp-server` only constructs it and owns its lifecycle (startup, interval,
shutdown), as it hosts `acp-capability-host`; no reconciler logic lives in
`acp-server` or any other existing package. Run one deterministic instance under
its service principal on one designated node. It scans current wrkq state on startup and every 30–60 seconds, with no controller
database or event cursor:

```text
for each task or subtask carrying meta.acp.request:
    observe reserved starts, claims and stalls
    start only open, unclaimed requests
    skip archived/deleted requests and archived/deleted subtask owners
    wait unless its assignee is a valid configured agent and capacity is free
    start that assignee's task or subtask session with the stable request key
```

The roster lives only in the request skill as guidance; the reconciler resolves
valid agents through existing HRC/ASP authority. A human assignee stays visibly
assigned and is never started. Use configured global and per-agent capacity
limits (defaults: four total, two per agent). Active claims and current reserved
starts count after restart too. Capacity is a soft cost limit, exact only for the
single designated instance: an accidental second copy evaluates capacity
independently and can admit past the limit, by at most its own limit. Start
uniqueness, not capacity, is the correctness guarantee: no copy, scan or restart
dispatches twice for `recon:<requestId>:<rev>:<workerScope>`. Completed
owners do not cancel their subtasks. Dependency-gated requests are a follow-on;
neither example needs a separate dependency scheduler.

**Chosen start path:** a native HRC start places the session and delivers its
initial assignment without a collaboration envelope or reply obligation. The
reconciler calls the HRC client directly: `summon` the task or subtask scope,
then a queued `turn` carrying the assignment for `<requestId>@<rev>`. HRC retains
placement authority. Whether HRC accepts a cold-scope start from the reconciler's
service principal is the first implementation check. Lance has also approved an
addressed `wrkc say` transport, but it is not part of this design: if the check
fails, this proposal is revised to that transport, including its reply-obligation
protocol, and resubmitted before building it.
Today's scribe `/v1/inputs` route is not that path: human actors are converted
into addressed ledger messages; service actors enter a launcher that refuses
cold/nonlocal ledger-owned scopes. The reconciler must not impersonate a human
or bypass that refusal.

The keyed `delegation.started` fact is the start reservation and is written
**before** dispatch: `wrkp post --task <requestId> --key <startKey>` with flat
attributes `requester`, `assignee_seat` and `rev`. The fact also carries
`start_key`, equal to its idempotency key, because timeline entries do not expose
idempotency keys and the unclaimed-reservation stall rule reads the reservation's
key and time from the fact itself. A new fact means this copy
owns the start and dispatches; a replay returning `(existing)` means the start
was already reserved, so it skips dispatch. Rescans and a second controller copy
therefore never dispatch twice. The fact records the reservation; HRC supplies
the actual session and turn lifecycle evidence. A reservation counts as current
only while the request is unfinished and its `rev` and assignee still match the
reserved ones. The worker's claim is the only confirmation the assignment
landed; see the stall rule below.
HRC adds `assignment` as the `session.born` cause for a session born by this path,
alongside the existing `summon` cause. A start into an existing session does not
invent another birth.

An illustrative `wrkp log --task <owner>` view is below. Concurrent producers can
interleave; the birth appears only when a new session is created.

```text
T-owner.diagram  task.created        requester=agent:mable
T-owner.diagram  delegation.started assignee_seat=arris@project:T-owner.diagram rev=1
T-owner.diagram  session.born        cause=assignment
T-owner.diagram  task.claimed        worker=agent:arris
T-owner.diagram  comment             result: editable document + preview
T-owner.diagram  task.state          in_progress → completed
T-owner.diagram  task.claim_released
```

A shared `delegated-work` skill tells the worker to read its request, its owner's
shared context when present, and the activity timeline, then claim before touching
outputs. The initial start identifies the assignment as `<requestId>@<rev>`
for the worker's own principal. Only that initial-assignment path treats
completed or already claimed work as a no-op, including a claim under the same
scope; ordinary conversation can request revisions. **Assignment fencing:** after
claiming, the worker re-reads the request and proceeds only if its current
assignee is the worker's own principal and its `rev` equals the delivered one.
Otherwise it rejects without touching outputs, in this order. **Guarded reopen,
while still holding the claim:** only if that post-claim re-read shows the state
the claim set, `in_progress`, it sets the request back to `open` with
`--if-match <etag>` from the same read (claiming had moved it to `in_progress`,
and release does not restore state). Any other state in the snapshot, such as
`cancelled`, means someone else has decided the request's fate: the worker skips
the reopen. **Then release.** Holding the
claim means no successor can claim or complete the request before the reopen, and
the etag precondition means any intervening change, such as a cancellation,
fails the reopen instead of being overwritten. On a skipped reopen or a failed
precondition the worker only releases. After release the worker writes no
further task state. The reopened request is ordinary open, unclaimed work, so the
next scan reserves a start for its current assignee. A request reassigned before
any claim can be started for both assignees, but only the current assignee keeps
the claim. If the current assignee's start arrives while the old assignee
briefly holds the claim, it no-ops; the request then surfaces through a stall
rule below rather than running twice. A rejecting worker that dies before
releasing, whether before or after its reopen, leaves a claim held by an ended
worker, which the ended-holder rule reports. One whose guarded reopen fails on an
unrelated edit and then releases leaves the request `in_progress` and unclaimed,
which the orphan rule reports. One that skipped the reopen because the request
was already cancelled or completed leaves that finished state untouched.
Reassigning work that is already claimed is deliberate recovery, as for any held
claim.

The worker records useful outputs and integration decisions on its request task
or subtask, completes it, and releases its own claim while it still has the
token. It never messages the reconciler. **The worker returns the result:** after
completing, it sends one `--fyi` notice to the requester, addressed to
`requesterScopeRef` when set, otherwise the scope-less `requesterPrincipalRef`.
A DM revision ends the same way, so each completion produces its own notice from
the session that made it; nothing depends on a scan observing a transient state.
The durable result is the request's state and result comment. A notice lost
after completion leaves that result intact and visible in `wrkp`. Notices create
no reply obligation and never birth an unborn requester seat; delivery when the
requester next runs must be proved. The reconciler sends only stall notices.

Questions, clarifications and revisions use ordinary messages in the owner's
room, or the request task's own room when it has no owner. Messaging keeps its
existing ability to wake or start a seat. For an explicit revision to completed
work, the worker marks the same task or subtask `in_progress` with `--if-match`
on the completed state it read, so a concurrent cancellation or edit is not
overwritten, then claims it, updates its result, and completes and releases it.
This avoids reopening it as an unclaimed `open` reconciler request. Pure
questions leave completed state alone. The revision shows as
`completed → in_progress` and a claim, with no `delegation.started` fact. A missing
claim token or stranded claim requires deliberate recovery, never an automatic
takeover.

## Two examples and the migration

**Diagram:** create `T-owner.diagram`, assigned to the Arris specialist. That
session reads the relevant material, loads Arris, produces the editable document
and renders its preview. Both outputs are recorded on that subtask. Rendering is
ordinary specialist tool work; there is no controller-side renderer or mandatory
second subtask. Independently delegated review can be another subtask.

**Scribe artifact — second phase:** migrate `scribe request` from taskboard's
ArtifactRequest store to `T-owner.<slug>`, or a top-level request task when there
is no owner, assigned to scribe. Put the brief in its description and
`{ slug, kind, replace }` in `meta.scribe`, beside the generic
`meta.acp.request`. The reconciler never reads specialist-specific fields.
Each artifact gets `scribe@<project>:<requestId>`, such as
`scribe@<project>:T-owner.<slug>`, replacing the single shared owner context.
Scribe publishes with `--task <requestId>`, records the existing artifact
`detailUrl` as its result, and completes the request. Taskboard's Requests strip
becomes a request task/subtask projection;
published artifacts, serving URLs and the artifact operation ledger remain.

Publishing must resolve the supplied request and match its declared slug;
`--task` currently only supplies attribution and is not this enforcement.
Initial replacement of an existing artifact requires recorded replace intent.
Later corrections may replace only the artifact linked to that request, with
its slug checked against the artifact store. A DM requesting changes returns
to the same isolated session and updates the same result. Existing publish
idempotency and stale-operation checks remain.

For project-only requests, use the requester's current task as owner when it is
in a task seat; otherwise the request itself is a top-level inbox task carrying
the marker. Its worker seat is `<agent>@<project>:T-x`. This is the chosen policy
for now. Requiring an owner instead is a possible future tightening, not a flag.
Label automation should create requested subtasks rather than start workers
itself; preserve `needs_explainer` publishing and the separate `needs_docs`
registered documentation-maintenance behavior. Before switching an intake,
stop its old dispatcher so one request has one start path. Preserve existing
request history and published artifact links; drain or explicitly transfer
in-flight requests before removing the old request store and sweeper.

## Stalls, recovery and proof

The reconciler reports three stalls, all read from current state, so polling
cannot miss them. The claim window defaults to ten minutes, since claiming is the
worker's first act.

- **Ended holder:** a held claim on unfinished work whose observed worker ended.
- **Unclaimed reservation:** a current reservation whose request is still
  unclaimed and unfinished after the claim window. It covers a dispatch that
  never ran, a turn that failed before claiming, and an assignment lost in an
  existing seat, without correlating a dispatch identity.
- **Orphaned in progress:** a request that is `in_progress` and unclaimed, with
  no current reservation, for longer than the claim window since its last update.
  Only `open` requests are started, so without this rule such a request would
  neither start nor stall. It covers a rejecting worker whose guarded reopen
  failed on an unrelated edit before it released, and a DM-revision worker that set `in_progress` but never claimed.

Every unfinished, unclaimed request is therefore either startable (`open`, no
current reservation), awaiting a claim inside the window, or reported. Recovery is deliberate: inspect the seat, then bump `rev` and reopen,
or reassign. Idle detection is deferred; HRC's existing
reap process covers it for now. The reconciler does not read HRC last-activity
timestamps. A failed HRC read means unknown, not a timeout. Stalls are observations,
not new task states: post `delegation.stalled` on the request and notify once per
episode. The key names the episode, not just the request:
`stall:<requestId>:<kind>:<episode>`, where the episode is the reservation's start
key (which carries `rev` and worker scope) for an unclaimed reservation, and the
claim generation for an ended holder and for an orphan (release keeps the
generation). A later worker's failure, after reassignment at the same `rev` or
after a new claim, is therefore a new episode with its own fact and notice. Do not release, retry or mark
work failed automatically. Explain reads show readiness, reservation and stall
evidence.

A deliberate fresh reconciler run bumps `rev` and reopens the request, after
checking and releasing any stranded claim. Ordinary metadata edits do not rerun
completed work. Cancellation stops new starts; stopping running work uses
existing HRC controls. No new attempts, acceptance service, artifact store,
presence system or automatic failover is introduced.

Prove the shared machinery with diagram work first: requester fields and claim
visibility in wrkq, the reconciler and keyed HRC start, and the two shared skills.
Then migrate scribe onto it, keeping that migration in the design and delivery
scope.

MVP proof on installed surfaces: separate owner/specialist skill contexts;
requester and sibling-worker visibility; real subtask session facts in the
owner's `wrkp` view; duplicate-start suppression across restart and two loop
copies; reassignment before claim, where only the current assignee keeps the
claim; worker completion notices for both the initial completion and a DM
revision, including a revision immediately after completion; ended-holder and
reserved-but-unclaimed and orphaned-in-progress reporting, including a turn that
fails before claiming, a rejecting worker whose guarded reopen loses to a
concurrent cancellation, including a cancellation already present in the
post-claim snapshot (cancellation preserved, nothing restarted), or to an
unrelated edit (request left `in_progress`, orphan reported), and a
rejecting worker that dies between reopen and release;
assignment rejection followed by a reserved start for the new assignee; a second
stall episode after reassignment at the same `rev`, reported separately;
and notice delivery when an ended requester next runs. Verify default-visible
creations with requester fields, one `delegation.started` per reserved start,
`session.born cause=assignment` for new sessions, one `delegation.stalled` per
episode, and a DM revision with state/claim activity but no new delegation start.
Exercise both named subtasks and top-level requests. Scribe migration proof adds
two artifacts in separate sessions, taskless intake, existing request links
preserved, correct-slug replacement and wrong-slug refusal. A publish that
succeeded before a worker died remains visible in the artifact store for
deliberate recovery.

This revision is design work only. The wrkq requester/projection changes, the
HRC start path and the taskboard migration need cross-repo design review before
implementation. Native start, taskless ownership, idle deferral and migration
sequencing are settled; Daedalus review is the next design gate. The diagrams
describe this proposal; previous drafts remain in Git history and wrkc room
R-00241.

Diagrams: [system view](acp-reconciler-design/architecture.png)
([editable](acp-reconciler-design/architecture.arris.json)) and
[flow](acp-reconciler-design/protocol.png)
([editable](acp-reconciler-design/protocol.arris.json)).
