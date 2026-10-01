# ACP reconciler: delegated sessions

**Product decisions settled with Lance; implementation design pending Daedalus
review.** Cody and Mable's peer revision, October 1, 2026. The goal is recorded in
[Delegated work and session context isolation](acp-delegated-work-intent.md).

The requester records a concern as a task or subtask and goes back to its work.
The reconciler starts the assigned specialist in a separate session, notices
completion or stalls, and reports back. The specialist loads its own skills,
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

Run one deterministic reconciler in `acp-server`, under its service principal.
It scans current wrkq state on startup and every 30–60 seconds, with no controller
database or event cursor:

```text
for each task or subtask carrying meta.acp.request:
    observe admitted starts, completion and stalls
    start only open, unclaimed requests
    skip archived/deleted requests and archived/deleted subtask owners
    wait unless its assignee is a valid configured agent and capacity is free
    start that assignee's task or subtask session with the stable request key
```

The roster lives only in the request skill as guidance; the reconciler resolves
valid agents through existing HRC/ASP authority. A human assignee stays visibly
assigned and is never started. Use configured global and per-agent capacity
limits (defaults: four total, two per agent). Active claims and durable
admitted starts count after restart too. A repeat scan or accidental second copy
must not admit new work for `recon:<requestId>:<rev>:<workerScope>`. Completed
owners do not cancel their subtasks. Dependency-gated requests are a follow-on;
neither example needs a separate dependency scheduler.

**Chosen start path:** supported keyed HRC work admission places the session and
delivers its initial assignment without a collaboration envelope or reply
obligation. HRC retains placement authority.
Reuse its existing admission/idempotency machinery rather than a new queue.
Today's scribe `/v1/inputs` route is not that path: human actors are converted
into addressed ledger messages; service actors enter a launcher that refuses
cold/nonlocal ledger-owned scopes. The reconciler must not impersonate a human
or bypass that refusal.

After an accepted admission, the reconciler posts `delegation.started` on the
request through `wrkp post --task <requestId> --key <startKey>`. Its flat attributes
are `requester`, `assignee_seat`, `rev` and `admission_ref` (the HRC admission
reference). Re-reading an admitted start repairs a missing post with that same
key; rescans and a second controller copy create no new fact. This marks the
admitted assignment; HRC supplies the actual session/turn lifecycle evidence.
HRC adds `assignment` as the `session.born` cause for a session born by this path,
alongside the existing `summon` cause. A start into an existing session does not
invent another birth.

An illustrative `wrkp log --task <owner>` view is below. Concurrent producers can
interleave; the birth appears only when a new session is created.

```text
T-owner.diagram  task.created        requester=agent:mable
T-owner.diagram  delegation.started assignee_seat=arris@project:T-owner.diagram rev=1 admission_ref=<HRC ref>
T-owner.diagram  session.born        cause=assignment
T-owner.diagram  task.claimed        worker=agent:arris
T-owner.diagram  comment             result: editable document + preview
T-owner.diagram  task.state          in_progress → completed
T-owner.diagram  task.claim_released
```

A shared `delegated-work` skill tells the worker to read its request, its owner's
shared context when present, and the activity timeline, then claim before touching
outputs. The initial start identifies the assignment as `<requestId>@<rev>`; the
worker checks that it matches the current request before acting. Only that
initial-assignment path treats completed or already claimed work as a no-op,
including a claim under the same scope; ordinary conversation can request
revisions. The worker records useful outputs and integration decisions on its
request task or subtask, completes it, and releases its own claim while it still
has the token. It never messages the reconciler; the loop reads task state.
Results and stalls produce keyed notifications to the requester, using existing
room messaging and deduplication. Notice keys include request ID, revision, claim generation
and notice kind, so a DM revision gets its own completion notice. Address
`requesterScopeRef` when set, otherwise the scope-less
`requesterPrincipalRef`. Notifications create no reply obligation and never
birth an unborn requester seat; delivery on its next run must be proved.

Questions, clarifications and revisions use ordinary messages in the owner's
room, or the request task's own room when it has no owner. Messaging keeps its
existing ability to wake or start a seat. For an explicit revision to completed
work, the worker marks the same task or subtask `in_progress`, claims it, updates
its result, then completes and releases it.
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

The reconciler reports a held unfinished claim whose observed worker ended. It
also reports admitted work that never starts within the configured start
confirmation window of two minutes. Idle detection is deferred; HRC's existing
reap process covers it for now. The reconciler does not read HRC last-activity
timestamps. A failed HRC read means unknown, not a timeout. Stalls are observations,
not new task states: post `delegation.stalled` on the request and notify once per
episode, using an episode key for both deduplication paths. Do not release,
retry or mark work failed automatically. Explain reads show readiness, admission
and stall evidence.

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
owner's `wrkp` view; duplicate-start suppression across restart/two loop copies;
completion and DM revisions; ended-worker and never-started reporting; and
notification delivery when an ended requester next runs. Verify default-visible
creations with requester fields, one `delegation.started` per keyed admission,
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
