# ACP reconciler proposal

**Status: proposed, not approved, and not yet submitted to Daedalus.**

Design discussion dated September 30, 2026; consolidated by stella (Codex app)
from the proposal in EN-21218, Mable's review in EN-21220 (room R-00241), and
Lance's subsequent discussion. Writing and publishing this document authorizes
no implementation, tasks, service changes, or architecture-review dispatch.

Design-review diagrams by Cody (October 1, 2026) propose a canonical attempt and
acceptance contract in wrkq, reusing task claims, with ACP owning readiness and
recovery. These are review drafts, not approved architecture or installed behavior:

- System boundaries: [PNG](acp-reconciler-design/architecture.png) ·
  [editable Arris document](acp-reconciler-design/architecture.arris.json).
- Execution protocol: [PNG](acp-reconciler-design/protocol.png) ·
  [editable Arris document](acp-reconciler-design/protocol.arris.json).

## Purpose and current foundation

Make explicitly requested work progress when its inputs, authorization and
execution capacity permit, without keeping a model running to wait. Preserve
ordinary addressed push dispatch. A graph can later show the work, sessions,
available capabilities and results from their owning systems.

Named subtasks provide the work records. The concrete contract is
`wrkq/docs/named-subtasks-proposal.md`, revision 5 plus its Events extension,
delivered in wrkq `ce5dd9a`. A subtask is an ordinary task row identified by
`T-12345.diagram`, with a stable UUID and immutable owner and slug. It consumes
no new global task number. It inherits its owner's residency, effective room and
workspace, but has independent claims, state and reply obligations. Roles remain
supported; the earlier graph handoff's proposed role removal was dropped.

Owner event selectors include subtask events while preserving their exact IDs.
State predicates remain exact. Comments and attachments belong to their own
records. Subtasks are not campaign members, cannot own child tasks or subtasks,
and cannot attach wrkf instances in v1. Completing an owner does not complete its
subtasks. The core's validation and live rollout evidence were inspected; Mable
subsequently reported the complete named-subtasks campaign, including Taskboard,
closed and live. That does not imply the reconciler or graph is implemented.

The historical context is in
`architecture-assessment/graph-session-handoff.md` and
`architecture-assessment/graph-detailed-artifact-reference.md`. The published
[earlier proposal](http://100.73.60.81:18450/a/latent-work-graph-reconciliation)
and [spatial graph companion](http://100.73.60.81:18450/a/latent-work-graph-network)
still use the superseded term “activity.” The newer animation is a visual
companion, not the complete architecture or a replay of installed behavior.

## Package, process and placement

Introduce `acp-reconciler` as a distinct package, initially hosted by
`acp-server`. It owns readiness policy, reconciliation decisions and recovery
coordination through narrow work, dispatch, execution and result interfaces.
The server owns lifecycle wiring, event intake, timers and shutdown. Long-running
agent or deterministic work runs outside the reconciliation loop, with bounded
concurrency and durable execution references.

**Lance has decided that the reconciler runs on one designated node.** The
specific host is open. Agents may still run wherever existing HRC placement
puts them. Mable and Stella agree on starting with one owner; introducing
multi-node reconciliation is not part of this proposal. Restart recovery and
accidental duplicate startup still need safe admission. Relocation must stop the
old owner before enabling its replacement; automatic failover is not proposed.

This follows the existing single-member schedule ownership model without
assuming that ACP's jobs scheduler provides fleet-wide admission. The active
record `acp.jobs.node-execution-ownership` describes independent per-node fan-out;
`acp.jobs.static-owner-set-no-peer-makeup.v1` explicitly accepts the absence of
peer makeup. Those records constrain reuse, rather than supplying a new
reconciler's complete ownership contract.

Wrkq remains the authority for work records and claims, wrkc for conversations
and obligations, HRC for runtime placement, and wrkf for its own workflow rules.
The graph is a combined projection, not another authority. No universal
execution-framework extraction is a prerequisite.

## Discovery and requesting work through skills

Lance's later discussion raised the missing first step: how Mable discovers that
requesting a diagram is possible. The direction under discussion is a capability
catalog exposed as skills. This is a proposal, not a selected catalog schema.

A skill such as “request an architecture diagram” describes when it is useful,
what context to provide and what output to expect. Using it requests the
capability against an owner task and creates a named subtask carrying the
execution declaration. The requester need not assemble an agent address or know
which specialist implementation is currently bound. A “render preview” skill
can request a deterministic executor through the same model.

Stella recommends one skill per capability initially, named after the requested
help rather than the provider agent. A general discovery skill can search the
catalog as it grows. Skills and executable capability definitions must stay
linked and versioned so their instructions cannot drift. A skill describes how
to request work; a machine-readable definition supplies the executor and contract.
Mable's EN-21220 review predates this refinement and has not reviewed it.

Creation of an ordinary subtask remains passive. Graph inspection never activates
work. Automatic execution requires an explicit declaration and policy approval.
Missing executor selection is visible unassigned work, not permission for the
reconciler to infer an agent from the title.

## Execution declaration and authorization

A declaration identifies the capability or executor binding, inputs and their
versions, expected outputs, acceptance policy and notification recipient. Retry
limits and capacity constraints may come from policy defaults rather than
mandatory per-record fields. Existing wrkq relations express dependencies;
confirm their exact semantics before choosing the pilot's relation kinds.

Mable recommends a namespaced object in the task's existing `meta`, avoiding a
new RPC field and coordinated protocol release. Stella accepts metadata as a
plausible pilot home if it has a validated, versioned contract. The location
remains open. Use an immutable declaration/input snapshot or content revision for
admission: the task's general etag also changes for unrelated updates and must
not automatically cause a new execution.

Authorization cannot be granted by a declaration merely asserting that it is
authorized. Admission must validate the writer's authority and reconciler policy,
including who may change executor bindings and accepted output requirements.
Record the authorized principal and declaration provenance. The reconciler's
principal, node credential, mutation permissions and notification identity still
need a concrete contract; scope strings alone are not authentication.

## Event intake and recovery scans

Adopt Mable's recommendation to use wrkq's `HistoryTailView` as the durable event
source. It returns ascending event-log pages and a high-water cursor and supports
owner-inclusive selectors. Persist a reconciler-owned cursor and a queue of work
needing checks. Advance the cursor only after the corresponding checks have been
durably queued. Coalesce repeated events for one work record, and read current
canonical work state when evaluating it.

Reuse the existing wrkq webhook endpoint and payload validation as an optional
low-latency wake-and-poll signal. Do not consume the job scheduler's inbox or
processed marker. Existing event/job deduplication answers a different question
from whether a particular requested output already has an execution.

Cursor replay recovers notifications missed while ACP is down, provided the
ledger history remains available. It does not eliminate initial discovery,
cursor loss, ledger replacement or retention gaps. Define bootstrap discovery
and cursor invalidation/rebuild before implementation. Startup resumes the cursor
and reconciles admitted executions; bounded time-based checks revisit cooldowns,
deferrals and evidence deadlines. Audit sweeps remain a recovery mechanism if
source history cannot account for a gap. No model turn is needed for these checks.

## Readiness and explanations

Evaluate whether the request is still enabled and wanted, inputs and dependencies
are satisfied, authorization remains valid, capacity is available, retry limits
permit execution, and an existing claim or execution already owns the work.
Being unfinished alone is insufficient. Awaiting approval, evidence or an active
worker is a reason to wait.

Keep routine waiting explanations as ACP-local derived state exposed by an
inspect/explain read, with source revisions and freshness. Do not append a comment
on every check. Durable decisions and results belong on the work record. Carry
causation references on reconciler writes where the existing event contract
supports them. Self-originated events may require a state check even when they
must not cause another conversational turn.

## Admission: reuse first, with an unresolved correctness boundary

Mable recommends composing existing canonical primitives before adding an
attempt API. An idempotency-keyed wrkc send is protected by migration 000059's
unique envelope index, and a subtask claim has a single holder with monotonically
increasing generation and no TTL. The envelope and claim generation could identify
an agent attempt. A claimed subtask or pending/presented execution request would
suppress further dispatch. This is substantial reusable machinery.

Stella accepts testing that composition first but does not yet accept it as a
complete attempt contract. A deterministic scope ensures messages reach one seat;
it does not ensure that two turns in that seat cannot repeat side effects. A
manual unkeyed push can race reconciliation. Checking for an obligation and then
sending is not itself atomic. Mable accepts an extra message in that race for v1;
Stella would accept it only with proof that the worker treats it as a duplicate
request and does not repeat the work.

An idempotency key also needs an authoritative stable input revision and retry
ordinal. Independently chosen ordinals or general etags can defeat deduplication.
Migration 000059 keys on `(idempotency_key, COALESCE(to_principal_ref, ''))`, not
recipient scope; keys must distinguish work, execution revision and intended
recipient as appropriate. Specify replay readback after a collision, and recovery
of a crash between dispatch and recording its reference. An acknowledged envelope
is a messaging fact, not proof that work was accepted or execution stopped.

Stella's original recommendation was an atomic attempt-admission API with a
canonical record beside the work in wrkq. That remains the fallback if the existing
composition cannot meet the named cases. It must coordinate with task claims,
not introduce a second competing holder. Local ACP records may track processing,
but cannot alone arbitrate against direct dispatch through another node.

**Admission authority is open.** Prove the existing composition with concurrent
push, duplicate triggers and crash recovery before deciding whether a small
extension or explicit attempt record is necessary. Required attempt facts include
the work identity, admitted declaration and input versions, executor, dispatch
reference, claim generation, execution reference, results and acceptance decision.
They may be projected from existing records only where those records preserve them
unambiguously across retries.

## Agent and deterministic execution

Agent execution uses addressed wrkc traffic to the subtask scope and existing HRC
provisioning. ACP's local launcher refuses prompt delivery owned by the
collaboration ledger; the reconciler must respect that boundary. Specify who
receives the worker's reply. Mable points to the stored respond-to field; its
public API and discharge semantics must be verified before relying on it. A
non-conversational controller must not accumulate unread reply obligations.

For deterministic work, Mable proposes an executor principal with a matching
task-scoped identity that claims the subtask without provisioning a model seat.
Stella considers this reasonable if principal authorization, node attribution,
claim acquisition and crash recovery work without inventing a runtime session.
The identity choice remains open. Declare authorized operations, input/output
contracts, timeout, capacity and idempotency behavior for each handler.

ACP's capability host already stores operations, executions and events and can
look up operations by capability and idempotency key. It is a reuse candidate,
not proven atomic admission: the inspected index on those fields is non-unique,
and lookup plus insert alone would not exclude concurrent execution. Verify the
capability service's complete admission path and restart behavior. The flow
engine's bounded native/exec steps are another candidate, but their state is tied
to JobRuns. Neither package should be declared the shared execution foundation
merely because it has similarly named records.

## Recovery, results and acceptance

Before retrying, inspect the correlated envelope, claim and actual executor. A
coordination lease expiry, lost connection or timeout does not prove the old
worker stopped. Preserve uncertain execution as a visible condition. Task claims
have no TTL; takeover is an explicit fenced transition, not a timeout cleanup.
Retries need bounded backoff, durable identity and escalation after exhaustion.

Persist output and evidence before notification. For the first output-producing
pilot, adopt Mable's simple distinction: delivered output leaves the subtask in
progress; an authorized acceptor completes it after validating the admitted inputs
and output contract. Dependents unlock on accepted completion. Missing inputs or
unclear intent produce a focused question rather than an invented brief.

The reconciler must not infer semantic success from process exit or an HRC
terminal status. ACP's existing wrkf action reconciler is a useful precedent:
read canonical truth, record failure or a protocol breach idempotently, never
infer completion. Its wrkf-specific authority is not automatically authority to
fail arbitrary subtasks; define the corresponding failure policy explicitly.

Keep execution end, delivery and acceptance distinguishable. Deployment and
outcome verification remain separate facts where relevant, but require no new
states for the diagram pilot. A later standing-goal pilot would need fresh evidence
and settling rules. Notification failure never removes results. One-time outputs
remain one-time; keep-current behavior requires an explicit policy.

## Contracts still requiring specification

- **Cancellation:** stop new admission immediately. Define whether and how to
  cancel an in-flight agent or job, how late results are retained, and what evidence
  proves it stopped. A task-state change alone does not terminate a runtime.
- **Completed owner:** Stella recommends continuing previously authorized,
  non-blocking subtasks after owner completion, matching existing subtask semantics.
  Explicit request cancellation overrides that. Define eligibility under cancelled,
  archived and deleted owners; archived/deleted owners already refuse new claims.
- **Controller identity:** specify the reconciler's principal, authenticated node
  credential, permitted writes and reply/notification routing. Do not impersonate
  the requester to make authority checks pass.
- **Capacity:** configure global and per-executor limits at the designated
  reconciler, including whether admitted-but-not-started work occupies capacity.
  Reconstruct active usage after restart rather than resetting it to zero.
- **Edits during execution:** retain the admitted declaration/input snapshot and
  let the current attempt finish unless explicitly cancelled. Re-evaluate afterward;
  do not silently accept old output against changed requirements or launch a
  replacement merely because the task etag changed. Define who accepts stale output.

## Pilot and evidence

Both Mable and Stella recommend diagram → preview as the first implementation
pilot. Lance has not selected it. The earlier graph material named an opted-in
hook-duration responsibility as the first experiment, and that choice was never
formally replaced. The diagram pilot proves both executor kinds and dependency
unlocking, but not post-fix measurement settling.

The proposed scenario starts with a capability skill requesting
`T-12345.diagram`. An Arris specialist produces an editable diagram and evidence.
An acceptor completes the subtask. `T-12345.render` consumes the accepted version
and produces a PNG through a deterministic handler without a model seat. Both
results remain discoverable from the owner after it closes.

Acceptance must cover duplicate events, simultaneous push and reconciliation,
accidental second-controller startup, crashes before and after dispatch, partial
deterministic side effects, missed webhooks recovered by ledger replay, cursor
recovery, stale inputs, cancellation, owner closure, capacity reconstruction,
notification failure and waiting without model turns. Claims and message replay
alone are not evidence that external side effects happened only once.

## Decisions for Lance

These are the five questions raised in Mable's review, updated with Lance's later
single-node decision. The specific host remains open; single-node versus
multi-node is no longer an unanswered question.

| Decision | Mable's recommendation | Stella's recommendation | Status |
| --- | --- | --- | --- |
| Admission authority | Existing idempotent wrkc dispatch plus claims; accept the occasional extra message | Prove that composition prevents duplicate work; add canonical atomic admission only for demonstrated gaps | Open |
| Reconciler placement | One owner node; mini or max3 | One owner inside ACP initially; choose host after source access and operational ownership are checked | Single node decided by Lance; host open |
| Deterministic executor identity | Executor principal claims like an agent, without a seat | Agree in principle, pending authority and recovery proof; no fabricated runtime session | Open |
| Pilot | Diagram → render | Diagram → render; preserve hook-duration as a later evidence-settling case | Open; earlier pilot not formally replaced |
| Declaration home | Existing task metadata, versioned through etag | Namespaced validated metadata is plausible; pin the declaration/input revision separately from general etag | Open |

The skills-based discovery contract is an additional design topic introduced after
Mable's review. This document records that direction without claiming her approval.
After the unresolved contracts are settled, prepare the concrete design for the
required Daedalus review. This document has not been submitted.

## Source evidence and limits

Source inspection, not a new installed acceptance run. ACP was inspected at
`f41df34`; named-subtask wrkq evidence is anchored at `ce5dd9a`. Links below are
repository-relative; sibling-repository paths are explicit location hints.

ACP sources inspected by Stella and Mable:

- [Webhook ingestion](../../packages/acp-server/src/handlers/webhooks-wrkq.ts)
- [Job scheduler](../../packages/acp-jobs-store/src/scheduler.ts)
- [Event evaluation](../../packages/acp-server/src/jobs/event-job-evaluator.ts)
- [Flow execution](../../packages/acp-server/src/jobs/flow-engine.ts)
- [Workflow failure reconciliation](../../packages/acp-server/src/wrkf/action-reconciler.ts)
- [Capability host and persisted operations](../../packages/acp-capability-host/src/index.ts)
- [Node ownership invariant](../../architecture/records/invariants/acp.jobs.node-execution-ownership.yaml)
- [No peer makeup risk](../../architecture/records/risks/acp.jobs.static-owner-set-no-peer-makeup.v1.yaml)

Additional ACP sources: Stella inspected
`packages/acp-server/src/jobs/dispatch-step.ts`,
`packages/acp-server/src/integration/wrkf-effect-reconciler.ts`, server wiring in
`packages/acp-server/src/cli.ts` and the refusal in `real-launcher.ts`.
Mable additionally reported inspecting `packages/acp-server/src/jobs/exec-step.ts`.
The older current-spec prose is orientation; current source controls observed behavior.

Wrkq sources under `~/praesidium/wrkq/`, inspected by Mable and relevant portions
rechecked by Stella during consolidation:

- `internal/wrkqapi/claims.go` and migration
  `internal/db/migrations/000048_task_claim_authority.sql`: scope/principal rules,
  generation fencing and claim authority.
- `internal/store/rooms.go` and
  `internal/db/migrations/000059_envelope_admission.sql`: envelope identity,
  dispatch admission and idempotency uniqueness.
- `internal/wrkqapi/monitorview.go`: `HistoryTailView` replay and high-water cursor.
- Named-subtask baseline: `internal/db/migrations/000066_named_subtasks.sql`,
  `internal/taskfamily/filter.go`, `internal/taskmember/filter.go`,
  `internal/wrkqapi/rooms.go`, `internal/store/tasks.go`, and the workflow-attachment
  refusal in `internal/workflow/service.go`.

Core acceptance and activation evidence:
`~/praesidium/var/wrkq-artifacts/T-09897/VALIDATION.md`, its
`live-rollout/smoke.txt`, and the named-subtasks core task's activation comment
C-26185. Historical reports and source findings are distinguished from proposed
reconciler guarantees throughout this document.
