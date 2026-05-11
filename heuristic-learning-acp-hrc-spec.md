# ACP/HRC Workflow Learning System Specification

**Status:** Consolidated design specification  
**Date:** 2026-05-11  
**Primary boundary:** Learning work is ACP work. Learning tools are `wlearn` tools. Runtime traces are HRC records. Workflow authority remains ACP authority.

---

## 1. Executive Summary

This specification defines a workflow-learning system for ACP/HRC environments. It carries forward the useful parts of Hermes-style self-improvement—background review, procedural guidance, provenance, curation, and compression—while placing all learning lifecycle state under ACP workflow governance.

The system has three authoritative layers:

```text
ACP
  authoritative workflow state, workflow events, phases, roles, evidence,
  obligations, transitions, policy versions, learning-workflow lifecycle

HRC
  authoritative runtime/session/run/turn/tool/exec event log

wlearn
  tool provider and downstream learning service:
  trace materialization, replay/evaluation, summarization, clustering,
  candidate artifact drafting, and report generation
```

The central architectural rule is:

> Hermes-style learning flows become ACP workflows when they create, review, curate, label, evaluate, or promote learning artifacts. They do not become privileged background behavior and do not directly mutate workflow law, evaluator authority, raw logs, or infrastructure.

This design separates three categories of objects:

```text
Raw immutable records
  ACP workflow events
  HRC runtime events
  raw artifacts and effect records

Low-authority learning artifacts
  trace notes
  trace labels
  playbooks
  remediation recipes
  participant guidance
  supervisor guidance
  curation reports

High-authority learning artifacts
  workflow definitions
  transition requirements
  evidence schemas
  effect semantics
  evaluator suites
  task taxonomy
  authority rules
  capability boundaries
```

Low-authority artifacts can be learned, curated, archived, and activated through relatively lightweight ACP workflows. High-authority artifacts require deterministic replay, evaluation, role separation, and external promotion authority.

---

## 2. Background: Heuristic Learning and the Design Constraint

Jiayi Weng's article *Learning Beyond Gradients* defines Heuristic Learning as a process where a coding agent updates software structure rather than neural network weights. A Heuristic System is not a single rule or prompt; it includes programmatic policy, state representation, feedback channels, experiment records, replays or tests, memory, and an update mechanism. The article also emphasizes that such systems can forget in engineering-shaped ways: a new rule can break old scenarios, tests can be too narrow, memories can mislead the agent, shared interfaces can break, and rules can accumulate until the system becomes unmaintainable. Healthy systems therefore need both feedback absorption and compression. Source: <https://trinkle23897.github.io/learning-beyond-gradients/>.

The ACP/HRC environment is a good candidate for this style of learning because:

- ACP workflow state is explicit.
- ACP transitions can be replayed deterministically at the kernel level.
- HRC already captures rich runtime traces for runs, tools, turns, and executions.
- Multi-agent workflow failures are often visible as rejected transitions, missing evidence, stale context, failed effects, waivers, anomalies, and human overrides.
- Workflow artifacts can be patched, tested, staged, and promoted.

The main design constraint is that ACP workflow outcomes are sparse, noisy, and human-shaped compared with dense reward environments. Therefore, the system must distinguish deterministic policy learning from statistical operational improvement.

At low sample volume, learning claims should be limited to:

```text
this command now rejects under stale context
this SoD violation is caught
this evidence rule catches the bad case
this old trace still replays
this counterfactual remains illegal
```

Claims such as “cost decreased,” “tool calls decreased,” or “success rate improved” require enough traces, stratification, and confidence accounting. They should not drive automatic promotion at low N.

---

## 3. Core Principles

### 3.1 ACP governs learning work

All learning lifecycle state is represented as ACP workflow tasks. This includes trace triage, label review, playbook update, curation, patch proposal, evaluation, promotion, rollback, and changes to the learning workflows themselves.

### 3.2 HRC remains the runtime experiment record

HRC owns run/session/turn/tool/exec records. The learning system does not duplicate raw HRC streams. It stores references, ranges, summaries, metrics, labels, and derived artifacts.

### 3.3 `wlearn` is a tool provider, not an authority layer

`wlearn` provides materializers, evaluators, summarizers, clustering tools, artifact drafters, and reports. It does not own lifecycle state for learning workflows. It does not directly promote high-authority artifacts.

### 3.4 Snapshots are projections, not the learning source of truth

ACP workflow history must become append-only and event-sourced enough for replay. Snapshots can continue to exist as projections for efficient reads, but learning uses event history.

### 3.5 Raw records are immutable

Compression never deletes ACP/HRC raw records. Compression produces overlays: derived rules, archived notes, merged playbooks, deprecation records, and curation reports linked back to source events.

### 3.6 Learning artifacts have authority tiers

Low-authority artifacts can guide behavior. High-authority artifacts define legality, authority, evidence semantics, evaluator behavior, or task classification. These require different workflows and approval rules.

### 3.7 The learner does not control its own success signal

The learner may propose changes to policy, prompts, contracts, evidence schemas, tests, evaluators, and curation overlays. It may not promote those changes, mutate its evaluator, mark its own traces trusted, weaken evidence or authority constraints, suppress audit events, narrow task classification, or expand its authority without external promotion authority.

---

## 4. Authority Tiers and Artifact Definitions

### 4.1 Tier 0: raw immutable records

These are authoritative audit material. Learning workflows can read and reference them but cannot rewrite them.

Examples:

```text
ACP workflow events
HRC events
raw artifacts
accepted and rejected workflow commands
evidence attachment records
obligation records
effect intent and effect delivery records
participant and supervisor run records
human override records
patch promotion and rollback records
```

Properties:

- Append-only.
- Schema-versioned.
- Addressable by stable IDs.
- Replayable or projection-compatible.
- Redacted according to policy but not silently omitted.

### 4.2 Tier 1: derived diagnostic artifacts

These are low-authority diagnostic outputs derived from raw records.

Examples:

```text
trace summaries
trace assessments
review notes
diagnostic reports
candidate trace labels
failure classifications
HRC tool-error summaries
correlation reports
malformed trace reports
```

Properties:

- May be generated automatically.
- Must carry provenance.
- May be provisional or quarantined.
- Cannot change workflow legality.
- Cannot make a trace trusted for evaluation without review.

### 4.3 Tier 2: low-authority guidance artifacts

These guide agents or operators but do not define legal workflow behavior.

Examples:

```text
workflow playbooks
remediation recipes
participant guidance
supervisor guidance
operator notes
curated trace-derived tips
common failure checklists
```

Properties:

- Can be produced through lightweight ACP learning workflows.
- Can be activated, archived, pinned, or marked stale.
- Can influence context generation and guidance.
- Cannot override ACP transitions, evidence requirements, role bindings, authority checks, or evaluator rules.

A guidance artifact may say:

```text
For code-defect verification, QA evidence should include command, exit code,
relevant output, changed files, and reproduction status.
```

It may not say:

```text
Allow verified phase if the participant says tests looked fine.
```

### 4.4 Tier 3: governed high-authority artifacts

These affect the legality, authority, validation, or evaluation of workflow behavior.

Examples:

```text
workflow definitions
transition rules
role and separation-of-duty rules
evidence schemas
evidence freshness requirements
effect semantics
evaluator suites
task taxonomy
promotion thresholds
capability boundaries
authority model changes
```

Properties:

- Proposed through ACP workflows.
- Evaluated through deterministic replay and/or governed evaluation.
- Promoted only by external authority or designated promotion roles.
- Rollbackable.
- Cannot be self-promoted by the proposer.

### 4.5 Tier 4: protected infrastructure

These are outside ordinary learning workflows.

Examples:

```text
ACP kernel
HRC event recorder
ledger append permissions
evaluator promotion authority
capability boundary enforcement
audit system
raw log storage
security policy
identity and access control
```

Properties:

- Not directly modifiable by learning agents.
- Changes require operator/admin workflows or external governance.
- Learning workflows may generate reports or proposals about them, but not apply changes.

---

## 5. Source-of-Truth Boundaries

### 5.1 ACP

ACP owns:

```text
workflow definitions
workflow versions
workflow tasks
phase transitions
role bindings
evidence and obligations
effect intents and delivery outcomes
supervisor actions
participant run admission and completion records
learning-workflow states
patch lifecycle states
promotion requests and outcomes
```

ACP must become event-sourced enough that workflow history can be replayed and audited.

### 5.2 HRC

HRC owns:

```text
host session identity
runtime identity
run identity
launch identity
turn and message events
tool-call and tool-result events
exec events
HRC event sequence
stream sequence
lane/scope references
generation identity
raw runtime payloads
```

HRC is the experiment record for what agents and tools actually did.

### 5.3 `wlearn`

`wlearn` owns no authoritative workflow state. It provides tools for ACP learning workflows:

```text
materialize trace
summarize HRC range
run kernel replay
run evaluation suite
cluster related trace notes
draft playbook
draft remediation recipe
draft patch bundle
produce curation report
produce promotion report
```

### 5.4 Agent Spaces / harnesses

Harnesses execute agent processes and tools. They are not learning-policy authorities. Their traces flow into HRC; their workflow activity is mediated through ACP.

---

## 6. ACP/HRC Groundwork Phases

The first implementation phases are infrastructure and capture phases. They come before low-authority and high-authority learning workflows.

### Phase A0: terminology and identity normalization

Define distinct identifiers and stop overloading `runId`.

Recommended identity names:

```text
workflowTaskId        ACP task identity
workflowRunId         ACP workflow-level run/episode identity, if needed
supervisorRunId       ACP supervisor action/run identity
participantRunId      ACP participant run identity
hrcRunId              HRC runtime run identity
runtimeId             HRC runtime instance identity
launchId              HRC launch identity
hostSessionId         HRC host session identity
scopeRef              HRC scope reference
laneRef               HRC lane reference
generation            HRC generation identity
```

Add explicit mapping records written at launch/admission time:

```ts
type WorkflowHrcRunMap = {
  mapId: string
  workflowTaskId: string
  participantRunId?: string
  supervisorRunId?: string
  hrcRunId: string
  runtimeId?: string
  launchId?: string
  hostSessionId?: string
  scopeRef?: string
  laneRef?: string
  generation?: number
  createdAt: string
  source: 'admission' | 'launch' | 'reconciled'
}
```

Rules:

- Required when ACP launches or admits an HRC-backed run.
- Derived later only when launch-time mapping was unavailable.
- Inferred mappings are marked as such and are lower confidence.

### Phase A1: ACP workflow event sourcing

Evolve ACP persistence from snapshot-as-source into event source plus projections.

Minimum event shape:

```ts
type AcpWorkflowEvent = {
  eventId: string
  workflowSeq: number
  schemaVersion: number
  createdAt: string

  workflowTaskId: string
  workflowRef: {
    id: string
    version: number
    hash: string
  }

  commandType?: string
  commandHash?: string
  causationId?: string
  correlationId?: string
  idempotencyKey?: string

  actor: ActorRef
  role?: string
  authority?: string

  observedTaskVersion?: number
  nextTaskVersion?: number
  contextHash?: string

  result: 'accepted' | 'rejected' | 'recorded'
  rejectionCode?: string

  payload: Record<string, unknown>

  eventHash: string
  prevHash?: string
}
```

`eventHash` and `commandHash` are MVP requirements. `prevHash` is optional or delayed. Full hash-chain sealing is not the first Goodhart defense; structural authority separation is.

Snapshots become projections:

```text
workflow_events -> workflow_task_projection
workflow_events -> workflow_evidence_projection
workflow_events -> workflow_obligation_projection
workflow_events -> workflow_effect_projection
workflow_events -> workflow_patch_projection
```

### Phase A2: accepted command event capture

Every accepted policy-relevant command emits an event.

Examples:

```text
task.created
context.issued
supervisor.action.accepted
participant.run.admitted
participant.run.completed
transition.accepted
evidence.attached
obligation.created
obligation.satisfied
obligation.waived
effect.intent.created
anomaly.recorded
patch.proposed
patch.evaluated
patch.staged
patch.promoted
patch.rolled_back
```

### Phase A3: rejected command event capture

Every rejected policy-relevant command emits a redacted event.

Examples:

```text
supervisor.action.rejected
transition.rejected
evidence.rejected
label.rejected
promotion.rejected
```

Required rejection codes:

```text
stale_context
version_conflict
unknown_transition
phase_mismatch
missing_role_binding
role_authority_violation
same_actor_sod_violation
missing_evidence
stale_evidence
invalid_evidence_schema
blocking_obligation
idempotency_conflict
unsupported_effect
capability_violation
promotion_authority_violation
evaluator_mutation_violation
```

Rejected attempts are high-signal learning data. They must not be lost.

### Phase A4: evidence provenance and freshness

Evidence records must be tied to workflow context and producing run.

Recommended shape:

```ts
type WorkflowEvidenceRecord = {
  evidenceId: string
  workflowTaskId: string
  kind: string
  schemaVersion: number
  schemaHash?: string

  producer: {
    actor: ActorRef
    role?: string
    participantRunId?: string
    supervisorRunId?: string
    hrcRunId?: string
  }

  producedAt: string
  taskVersionAtProduction: number
  phaseAtProduction: string
  transitionIntentId?: string
  artifactRefs: string[]

  semanticValidation?: {
    validatorId: string
    result: 'valid' | 'invalid' | 'inconclusive'
    reason?: string
  }
}
```

Evidence requirements should be able to express:

```text
kind required
schema required
producer role required
producer must differ from another role
fresh since task version N
fresh since phase entered
attached for this transition intent
semantic validator passed
```

### Phase A5: obligation lifecycle capture

Obligations are policy-relevant and must emit lifecycle events:

```text
obligation.created
obligation.updated
obligation.satisfied
obligation.waived
obligation.blocked_transition
obligation.expired
```

Waivers must carry provenance:

```ts
type ObligationWaiver = {
  obligationId: string
  waivedBy: ActorRef
  authority: string
  reason: string
  evidenceRefs: string[]
  taskVersion: number
  createdAt: string
}
```

### Phase A6: effect lifecycle capture

Effect delivery outcomes must be ledgered.

Events:

```text
effect.intent.created
effect.intent.leased
effect.intent.delivered
effect.intent.failed
effect.intent.unsupported
effect.intent.expired
effect.intent.retried
```

Unsupported effects must not be silently marked delivered.

Effect event shape:

```ts
type WorkflowEffectEventPayload = {
  effectId: string
  effectKind: string
  target?: string
  leaseId?: string
  reconcilerId?: string
  deliveryResult?: 'delivered' | 'failed' | 'unsupported' | 'expired'
  errorCode?: string
  errorMessage?: string
  sourceWorkflowEventId: string
}
```

### Phase A7: HRC event capture requirements

HRC must continue to capture the runtime stream with enough information to reconstruct run/turn/tool behavior.

Required classes:

```text
run lifecycle events
assistant/user/system turn events
tool call events
tool result events
exec start/finish/error events
artifact production events
runtime error events
session/generation/lane/scope identity events
```

HRC events should remain read-only to learning workflows.

### Phase A8: correlation and malformed trace handling

Trace materialization uses ACP workflow events plus HRC mappings.

Correlation confidence states:

```text
fully_correlated
partially_correlated
inferred_correlation
malformed
quarantined
```

A trace is not silently dropped. If malformed, it becomes visible through a trace triage workflow.

Required ingest report fields:

```ts
type TraceIngestReport = {
  traceId: string
  workflowTaskId: string
  correlationState: 'fully_correlated' | 'partially_correlated' | 'inferred_correlation' | 'malformed' | 'quarantined'
  missingKeys: string[]
  conflictingKeys: string[]
  hrcRanges: Array<{ hrcRunId: string; startSeq: number; endSeq: number }>
  workflowSeqRange: [number, number]
  warnings: string[]
}
```

### Phase A9: deterministic workflow-kernel replay

The first replay target is not bit-identical LLM behavior. It is deterministic workflow equivalence.

Replay input:

```text
workflow definition/version/hash
initial task projection
sequence of workflow commands
role bindings
evidence records
obligation records
context hashes
idempotency keys
```

Replay output:

```text
accepted/rejected result
rejection code
task version changes
phase changes
evidence/obligation/effect changes
emitted workflow events
```

Acceptance criterion:

```text
Given the same workflow kernel inputs, replay produces equivalent workflow outcomes.
```

HRC replay is used for diagnosis and summaries, not as the first correctness oracle.

---

## 7. Learning Agents and Roles

Learning agents are analogous to task supervisors in that they coordinate workflows, inspect context, request evidence, and apply transitions. They differ from task supervisors because they are skilled on learning artifacts, trace interpretation, evaluation, curation, and governance rather than direct task execution.

### 7.1 Learning Supervisor

Purpose:

```text
Coordinates learning workflows, ensures phase progress, assigns specialist roles,
checks required evidence, and prevents boundary violations.
```

Authority:

- May start learning workflow tasks.
- May request trace materialization.
- May request reviewer, curator, or evaluator participation.
- May apply low-authority workflow transitions when requirements are met.
- May not promote high-authority changes.
- May not mark its own artifacts trusted for evaluation.

Required skills:

```text
ACP workflow semantics
HRC trace interpretation
artifact authority tiers
Goodhart risk awareness
learning workflow phase management
role separation enforcement
```

### 7.2 Trace Reviewer

Purpose:

```text
Reads ACP/HRC traces and identifies failure modes, anomalies, repeated work,
missing evidence, malformed correlation, or candidate learning opportunities.
```

Outputs:

```text
TraceAssessment
FailureClassification
TraceNote
CandidateLabel
PlaybookCandidate
PolicyPatchCandidate
NoOpReport
```

Limitations:

- Cannot accept trusted labels.
- Cannot update workflow policy.
- Cannot promote guidance alone if policy-relevant.

### 7.3 Label Reviewer

Purpose:

```text
Reviews candidate trace labels and determines whether traces are usable for replay,
regression, diagnosis, or should be quarantined.
```

Authority:

- May accept, reject, or quarantine labels.
- Must provide provenance and reason.
- Must differ from the learner that proposed the label when label trust affects evaluation.

### 7.4 Playbook Author

Purpose:

```text
Drafts low-authority guidance, remediation recipes, participant guidance,
supervisor guidance, and operator notes.
```

Authority:

- May draft guidance.
- May revise guidance.
- May submit for activation.
- May not change workflow legality.

### 7.5 Playbook Reviewer

Purpose:

```text
Reviews low-authority artifacts for clarity, scope, safety, redundancy,
and conflict with workflow law.
```

Authority:

- May activate low-risk playbooks.
- May require curation or archive.
- Must escalate if guidance appears to encode policy law.

### 7.6 Curator

Purpose:

```text
Compresses derived learning artifacts into fewer, clearer, maintainable artifacts.
Archives stale guidance, merges duplicates, identifies conflicts, and produces reports.
```

Authority:

- May propose archive/merge/mark-stale actions.
- May apply low-authority curation when review conditions are met.
- May not delete raw ACP/HRC records.
- May not silently discard conflicting observations.

### 7.7 Patch Author

Purpose:

```text
Drafts composite patch bundles for high-authority artifacts.
```

Outputs:

```text
PatchBundle
Hypothesis
AffectedArtifactList
RiskAssessment
EvaluationPlan
RollbackPlan
```

Limitations:

- Cannot evaluate as final authority.
- Cannot promote.
- Cannot weaken requirements without explicit risk declaration.

### 7.8 Evaluator Runner

Purpose:

```text
Runs deterministic replay, regression suites, counterfactual tests,
and operational metric reports using approved evaluator definitions.
```

Authority:

- May execute approved evaluators.
- May attach evaluation reports.
- May mark result as passed/failed/inconclusive according to evaluator rules.
- May not change evaluator definitions.

### 7.9 Evaluation Steward

Purpose:

```text
Owns evaluator suite quality, frozen historical suites, and evaluation-change review.
```

Authority:

- May approve evaluator-suite changes.
- Must be separate from patch author for high-authority patches.
- Must preserve frozen suites for regression.

### 7.10 Promotion Reviewer

Purpose:

```text
Reviews high-authority patch bundles after evaluation and decides staging,
promotion, rollback, or rejection.
```

Authority:

- May approve stage/canary/promote according to policy.
- Must differ from patch author for high-risk changes.
- Must require human or external authority for capability expansion, evaluator mutation, requirement weakening, or authority model changes.

### 7.11 Learning Auditor

Purpose:

```text
Audits learning workflows for Goodhart channels, role violations,
label manipulation, anomaly suppression, evaluator drift, and taxonomy narrowing.
```

Authority:

- May open audit tasks.
- May quarantine learning artifacts.
- May block promotion pending review.
- May require additional evidence.

### 7.12 Correlation Steward

Purpose:

```text
Reviews malformed or inferred ACP/HRC correlations and decides whether traces are usable.
```

Authority:

- May accept inferred mappings with reason.
- May quarantine ambiguous traces.
- May require instrumentation fixes.

---

## 8. Role Separation Rules

Base rules:

```text
Trace Reviewer may propose labels, not accept trusted labels.
Label Reviewer may accept trusted labels, but must differ from learner-proposed label origin for eval-use labels.
Playbook Author may draft, not self-activate policy-adjacent guidance.
Patch Author may propose, not promote.
Evaluator Runner may run approved evaluators, not change evaluator definitions.
Evaluation Steward may approve evaluator changes, but not if they authored the patch being evaluated.
Promotion Reviewer must differ from Patch Author for high-authority patches.
Learning Supervisor may coordinate, not override protected boundaries.
Learner agents cannot approve their own evaluator, taxonomy, or trust-label changes.
```

High-risk changes require human or external promotion authority:

```text
capability expansion
requirement weakening
anomaly suppression
evaluator mutation
task taxonomy changes
authority model changes
evidence schema weakening
effect semantics changes that reduce auditability
```

---

## 9. Learning Process Families

All process families below are ACP workflow presets. They should live under a separate namespace.

Recommended namespaces:

```text
workflow namespace: learning/*
task namespace: learning-task/*
artifact namespace: learning-artifact/*
```

Recommended workflow presets:

```text
learning_trace_triage.v1
learning_trace_labeling.v1
learning_playbook_update.v1
learning_curation.v1
learning_policy_patch.v1
learning_patch_evaluation.v1
learning_patch_promotion.v1
learning_workflow_patch.v1
learning_audit.v1
```

---

## 10. Low-Authority Artifact Learning Workflow Phases

Low-authority learning is where the system should start. It is useful, simpler, and lower risk than changing workflow law.

### Phase L0: trigger selection

Do not review every task equally. Create learning tasks from high-signal events.

Triggers:

```text
stale context rejection
missing evidence rejection
same-actor SoD violation
effect delivery failure
unsupported effect intent
human override
obligation waiver
reopened task
repeated transition failure
anomaly
tool-error cluster
unusually high participant-run count
unusually high tool-call count
malformed ACP/HRC correlation
conflicting guidance report
```

Trigger event:

```text
learning.trigger.created
```

Trigger payload:

```ts
type LearningTrigger = {
  triggerId: string
  sourceWorkflowEventIds: string[]
  sourceHrcEventRanges?: Array<{ hrcRunId: string; startSeq: number; endSeq: number }>
  triggerKind: string
  workflowTaskId: string
  priority: 'low' | 'normal' | 'high' | 'urgent'
  reason: string
}
```

### Phase L1: trace triage workflow

Purpose:

```text
Determine whether a source trace is useful for diagnosis, replay, playbook learning,
policy-patch consideration, or quarantine.
```

Workflow states:

```text
observed
  -> trace_materialized
  -> reviewed
  -> classified
  -> closed_noop | playbook_candidate | policy_candidate | quarantined
```

Roles:

```text
Learning Supervisor
Trace Reviewer
Correlation Steward, if malformed
```

Required evidence:

```text
TraceIngestReport
TraceAssessment
FailureClassification or NoOpReport
```

Possible outcomes:

```text
no learning opportunity
create trace label workflow
create playbook update workflow
create policy patch proposal workflow
create instrumentation issue
quarantine trace
```

### Phase L2: trace labeling workflow

Purpose:

```text
Govern whether traces can be used for replay, regression, diagnosis, or are quarantined.
```

Workflow states:

```text
label_requested
  -> label_proposed
  -> label_reviewed
  -> accepted | quarantined | rejected
```

Trace label shape:

```ts
type TraceUseLabel = {
  traceId: string
  use:
    | 'usable_for_replay'
    | 'usable_for_regression'
    | 'usable_for_diagnosis'
    | 'quarantined'

  source: 'kernel' | 'human' | 'external_evaluator' | 'learner_proposed'
  confidence?: number
  reason: string
  reviewedBy?: ActorRef
  sourceEventIds: string[]
  createdAt: string
}
```

Rules:

```text
learner_proposed labels are provisional
trusted/eval-use labels require review
quarantined traces remain visible and counted
humanOverride labels require provenance
malformed traces are not silently excluded
taskClass changes are audited
```

### Phase L3: trace note workflow

Purpose:

```text
Capture diagnostic insight without changing guidance or policy.
```

Artifact shape:

```ts
type TraceNote = {
  noteId: string
  traceId: string
  author: ActorRef
  authorityTier: 1
  summary: string
  observations: string[]
  sourceEventIds: string[]
  sourceHrcRanges: Array<{ hrcRunId: string; startSeq: number; endSeq: number }>
  status: 'draft' | 'accepted' | 'quarantined' | 'archived'
  createdAt: string
}
```

Trace notes are useful when the finding is real but not yet general.

### Phase L4: playbook update workflow

Purpose:

```text
Convert repeated trace findings into low-authority procedural guidance.
```

Workflow states:

```text
drafted
  -> reviewed
  -> active
  -> stale
  -> archived
```

Artifact shape:

```ts
type WorkflowPlaybook = {
  playbookId: string
  title: string
  scope: {
    workflowIds?: string[]
    taskClasses?: string[]
    phases?: string[]
    roles?: string[]
  }
  authorityTier: 2
  guidance: string
  contraindications: string[]
  sourceTraceIds: string[]
  sourceEventIds: string[]
  lifecycle: 'draft' | 'active' | 'stale' | 'archived' | 'pinned'
  ownerRole: string
  createdAt: string
  updatedAt: string
}
```

Activation requirements:

```text
scope is explicit
does not contradict workflow law
does not imply authority it lacks
has at least one source trace or human-authored reason
reviewer differs from author for policy-adjacent guidance
```

### Phase L5: remediation recipe workflow

Purpose:

```text
Provide actionable recovery instructions for common failure modes.
```

Examples:

```text
missing QA evidence
stale context rejection
unsupported effect
malformed HRC correlation
participant run failed before evidence production
supervisor attempted transition without role binding
```

Recipe shape:

```ts
type RemediationRecipe = {
  recipeId: string
  failureMode: string
  appliesWhen: string[]
  steps: string[]
  requiredEvidenceAfterRemediation: string[]
  sourceTraceIds: string[]
  authorityTier: 2
  lifecycle: 'draft' | 'active' | 'stale' | 'archived' | 'pinned'
}
```

Recipes are guidance, not law.

### Phase L6: curation and compression workflow

Purpose:

```text
Prevent derived learning artifacts from growing into unmaintainable clutter.
```

Workflow states:

```text
curation_requested
  -> candidates_collected
  -> merge_plan_drafted
  -> reviewed
  -> applied | rejected
  -> report_written
```

Curator actions:

```text
merge duplicate playbooks
archive stale guidance
mark conflicting guidance
promote repeated trace notes into class-level playbooks
identify high-signal policy-patch candidates
preserve pinned artifacts
produce before/after report
```

Compression report shape:

```ts
type CurationReport = {
  reportId: string
  curator: ActorRef
  scope: string
  inputArtifactIds: string[]
  actions: Array<{
    action: 'merge' | 'archive' | 'mark_stale' | 'mark_conflict' | 'pin' | 'propose_policy_patch'
    artifactIds: string[]
    reason: string
  }>
  outputArtifactIds: string[]
  sourceTraceIds: string[]
  createdAt: string
}
```

Rules:

```text
raw ACP/HRC records are never deleted
archived artifacts remain recoverable
conflicts are visible
micro-guidance should consolidate into class-level guidance
compression cannot weaken policy
```

---

## 11. High-Authority Artifact Learning Workflow Phases

High-authority workflows govern changes to workflow law, evidence semantics, evaluator behavior, task taxonomy, effect semantics, and authority models.

### Phase H0: candidate escalation

A low-authority finding escalates to high-authority only when it is:

```text
replayable
policy-relevant
safety-relevant
authority-relevant
repeated across traces
a deterministic invariant violation
or impossible to address through guidance alone
```

Escalation output:

```text
PolicyPatchCandidate
EvaluatorPatchCandidate
EvidenceSchemaPatchCandidate
EffectSemanticsPatchCandidate
TaskTaxonomyPatchCandidate
```

### Phase H1: composite patch proposal workflow

Purpose:

```text
Draft a governed patch bundle that may touch multiple high-authority artifacts.
```

Workflow states:

```text
candidate
  -> patch_bundle_drafted
  -> risk_reviewed
  -> replay_ready
  -> evaluation_requested | rejected
```

Patch bundle shape:

```ts
type PatchBundle = {
  patchBundleId: string
  title: string
  hypothesis: string
  sourceTraceIds: string[]
  sourceEventIds: string[]

  facets: {
    workflowDefinitionChanges?: unknown
    transitionRequirementChanges?: unknown
    evidenceSchemaChanges?: unknown
    supervisorPolicyChanges?: unknown
    participantContractChanges?: unknown
    evaluatorSuiteChanges?: unknown
    effectSemanticsChanges?: unknown
    taskTaxonomyChanges?: unknown
    authorityModelChanges?: unknown
  }

  risk: {
    changesAuthority: boolean
    weakensRequirement: boolean
    expandsCapability: boolean
    changesEvaluator: boolean
    changesTaskTaxonomy: boolean
    suppressesOrReclassifiesAnomalies: boolean
  }

  evalPlan: {
    replayTraceIds: string[]
    regressionSuiteIds: string[]
    counterfactualSuiteIds: string[]
    requiredInvariants: string[]
    operationalMetrics?: string[]
  }

  rollbackPlan: string
  author: ActorRef
  createdAt: string
}
```

Rules:

```text
patches may be composite
facets must be explicit
risk must be declared
entangled patches can be rejected as unevaluable
requirement weakening requires external authority
changes to evaluator suites require Evaluation Steward review
```

### Phase H2: deterministic replay workflow

Purpose:

```text
Prove candidate changes preserve or correct deterministic workflow properties.
```

Workflow states:

```text
replay_requested
  -> replay_inputs_prepared
  -> replay_run
  -> replay_report_attached
  -> replay_passed | replay_failed | replay_inconclusive
```

Replay properties:

```text
stale context commands are rejected
SoD violations are rejected
missing evidence is rejected
stale evidence is rejected
blocking obligations prevent closure
unsupported effects do not silently deliver
old accepted traces remain accepted unless intentionally changed
old rejected traces remain rejected unless intentionally changed
```

Replay report shape:

```ts
type ReplayReport = {
  reportId: string
  patchBundleId: string
  evaluatorVersion: string
  replayTraceIds: string[]
  results: Array<{
    traceId: string
    outcome: 'passed' | 'failed' | 'inconclusive'
    failedProperties: string[]
    diffSummary?: string
  }>
  createdAt: string
}
```

### Phase H3: regression and counterfactual evaluation workflow

Purpose:

```text
Run approved suites against the patch bundle.
```

Workflow states:

```text
eval_requested
  -> regression_run
  -> counterfactual_run
  -> report_attached
  -> passed | failed | inconclusive
```

Suite types:

```text
regression
  previously solved traces or cases that must remain valid

negative
  illegal transitions or commands that must remain illegal

counterfactual
  perturbed traces: missing evidence, stale context, same actor in SoD roles,
  malformed evidence, unsupported effects

holdout
  related traces not used to draft the patch

operational
  metrics such as wall time, tool calls, waivers, anomaly rates, participant count
```

Evaluation claim ladder:

| Grade | Claim Type | Required Evidence |
|---|---|---|
| A | Deterministic invariant | Kernel replay/property tests; no sample-size claim needed |
| B | Regression protection | Curated replay/regression suite |
| C | Operational improvement | Predeclared metric, stratified task class, enough samples, confidence accounting |
| D | Diagnosis only | Anecdotal trace or provisional assessment; no promotion authority |

Low-N evaluation may support Grade A/B. It must not be presented as Grade C.

### Phase H4: patch promotion workflow

Purpose:

```text
Stage, canary, promote, roll back, or reject high-authority changes.
```

Workflow states:

```text
promotion_requested
  -> authority_review
  -> staged
  -> canary
  -> promoted | rolled_back | rejected
```

Promotion requirements:

```text
patch bundle complete
risk declared
replay report attached
evaluation report attached
required role separation satisfied
rollback plan attached
external authority present for high-risk changes
```

Promotion decisions:

```text
reject
request more evidence
stage for next workflow version
canary by task class
promote globally
roll back
```

Rules:

```text
same actor cannot author and promote high-authority patch
learner cannot promote evaluator changes
requirement weakening requires external authority
capability expansion requires external authority
anomaly suppression requires explicit audit
```

### Phase H5: high-authority rollback workflow

Purpose:

```text
Revert promoted policy or evaluator changes when regressions appear.
```

Workflow states:

```text
rollback_requested
  -> impact_assessed
  -> rollback_plan_verified
  -> rolled_back | rejected
  -> post_rollback_report_written
```

Rollback triggers:

```text
regression suite failure
unexpected anomaly suppression
increased invalid transition attempts
evidence validation bypass
human override spike
effect delivery regression
label trust violation
taxonomy narrowing detected
```

### Phase H6: learning-workflow patch workflow

Purpose:

```text
Govern changes to the learning workflows themselves.
```

Workflow states:

```text
learning_patch_candidate
  -> meta_eval
  -> external_review
  -> staged_next_version
  -> promoted | rejected
```

Boundary:

```text
A learning workflow may not alter its own current definition, evaluator,
success labels, role bindings, or authority model.
```

All changes apply only to future workflow versions.

---

## 12. Goodhart Risk and Structural Invariant

Workflow learning is highly exposed to Goodhart failures. A learner can appear to improve by:

```text
reducing tool calls by skipping checks
raising close rate by waiving obligations
reducing anomalies by suppressing anomaly creation
satisfying evidence requirements with empty but well-shaped evidence
avoiding failures by narrowing task classification
labeling losses as humanOverride
improving latency by launching fewer independent reviewers
mutating evaluator suites to match its own behavior
```

Invariant:

> The learner may propose changes to workflow policy, prompts, participant contracts, evidence schemas, tests, evaluators, curation overlays, and learning workflows. It may not promote those changes, mutate its evaluator, mark its own traces trusted, weaken evidence or authority constraints, suppress audit events, narrow task classification, or expand its authority without an external promotion authority.

Structural defenses:

```text
ACP ledger append authority outside learner
HRC event log read-only to learner
trace trust labels outside learner
promotion authority outside learner for high-risk changes
evaluator promotion outside learner
task taxonomy changes audited
humanOverride labels provenance-required
evidence schemas use semantic validators, not shape-only validation
anomaly-rate changes monitored, not treated as automatic improvement
malformed traces counted, not silently dropped
```

---

## 13. What Does Not Become an ACP Learning Workflow

Some system actions remain infrastructure or operator/admin work.

| System Piece | Boundary |
|---|---|
| ACP event append | Kernel infrastructure. Every ACP action emits events, but event append itself is not a learning workflow. |
| HRC event logging | Runtime infrastructure. Learning workflows can reference HRC records, not mutate them. |
| Trace materialization implementation | `wlearn` service/tool. Failures can create ACP tasks, but the implementation itself is infrastructure. |
| Evaluator runner implementation | Tool/infrastructure invoked by ACP workflows. Evaluator definitions are governed separately. |
| Snapshot projection rebuilds | Infrastructure. Not a learning workflow. |
| Ledger repair/migration | Operator/admin workflow, not self-improvement workflow. |
| Promotion authority | External authority surfaced through ACP, not delegated to the learner. |
| Identity and capability enforcement | Protected infrastructure. Learning may report issues, not rewrite enforcement. |

---

## 14. Interfaces and Commands

### 14.1 ACP surfaces

ACP owns workflow lifecycle. Learning workflows appear as normal ACP workflows in the `learning/*` namespace.

Example task kinds:

```text
learning-task/trace-triage
learning-task/trace-labeling
learning-task/playbook-update
learning-task/curation
learning-task/policy-patch
learning-task/patch-evaluation
learning-task/patch-promotion
learning-task/learning-workflow-patch
learning-task/audit
```

### 14.2 `wlearn` tool surfaces

`wlearn` commands are tools invoked by ACP roles, not lifecycle authorities.

Examples:

```bash
wlearn trace materialize --task <workflowTaskId>
wlearn trace summarize --trace <traceId>
wlearn hrc summarize-range --hrc-run <hrcRunId> --start <seq> --end <seq>
wlearn replay run --trace <traceId> --candidate <patchBundleId-or-workflowHash>
wlearn eval run --suite <suiteId> --candidate <patchBundleId>
wlearn playbook draft --trace <traceId>
wlearn patch draft --trace <traceId> --target <facet>
wlearn curate report --scope <scope>
wlearn cluster notes --scope <scope>
```

The outputs become ACP evidence or derived learning artifacts.

### 14.3 Promotion requests

`wlearn` may produce a promotion report, but promotion is an ACP workflow transition.

```text
wlearn output: PromotionReadinessReport
ACP action: promotion_requested -> authority_review -> staged/canary/promoted/rejected
```

---

## 15. Data Model Summary

### 15.1 Workflow trace

```ts
type WorkflowTrace = {
  traceId: string
  workflowTaskId: string

  workflow: {
    id: string
    version: number
    hash: string
  }

  workflowSeqRange: [number, number]
  hrcRanges: Array<{
    hrcRunId: string
    startSeq: number
    endSeq: number
    correlationState: 'direct' | 'derived' | 'inferred'
  }>

  initialProjectionHash: string
  finalProjectionHash: string

  outcome: {
    phase?: string
    closed: boolean
    result?: 'success' | 'failure' | 'abandoned' | 'inconclusive'
    humanOverride: boolean
  }

  metrics: {
    transitionsAccepted: number
    transitionsRejected: number
    supervisorActionsAccepted: number
    supervisorActionsRejected: number
    evidenceAttached: number
    evidenceRejected: number
    obligationsCreated: number
    obligationsWaived: number
    anomaliesRecorded: number
    participantRuns: number
    hrcToolCalls: number
    hrcToolErrors: number
    wallMs: number
  }

  correlation: {
    state: 'fully_correlated' | 'partially_correlated' | 'inferred_correlation' | 'malformed' | 'quarantined'
    missingKeys: string[]
    warnings: string[]
  }
}
```

### 15.2 Learning artifact base

```ts
type LearningArtifactBase = {
  artifactId: string
  artifactKind: string
  authorityTier: 1 | 2 | 3
  lifecycle: string
  origin:
    | 'human_directed'
    | 'background_review'
    | 'kernel'
    | 'external_evaluator'
    | 'curator'
    | 'learner_proposed'
    | 'promotion_authority'
  sourceTraceIds: string[]
  sourceEventIds: string[]
  createdBy: ActorRef
  createdAt: string
  updatedAt: string
}
```

### 15.3 Promotion report

```ts
type PromotionReadinessReport = {
  reportId: string
  patchBundleId: string
  replayReportIds: string[]
  evalReportIds: string[]
  riskSummary: string
  requiredAuthorities: string[]
  unmetRequirements: string[]
  recommendation: 'reject' | 'request_more_evidence' | 'stage' | 'canary' | 'promote'
  rationale: string
  createdAt: string
}
```

---

## 16. Implementation Plan

### Phase 1: ACP/HRC capture foundation

Goals:

```text
normalize run identities
append accepted workflow command events
append rejected workflow command events
append effect lifecycle events
preserve evidence provenance/freshness
write ACP↔HRC run mappings at launch/admission
make snapshots projections
```

Exit criteria:

```text
one real workflow task has complete ACP event history
one HRC-backed participant run is mapped to ACP participantRunId
accepted and rejected commands are visible in workflow history
effect delivery outcomes are visible in workflow history
```

### Phase 2: deterministic workflow replay

Goals:

```text
materialize one trace
replay workflow kernel inputs
verify equivalent policy outcomes
report divergence clearly
```

Exit criteria:

```text
one known-good trace replays equivalently
one known-bad/rejected command replays equivalently
replay report can be attached as ACP evidence
```

### Phase 3: low-authority learning workflows

Goals:

```text
implement trace triage workflow
implement trace labeling workflow
implement playbook update workflow
implement curation workflow
implement Learning Supervisor, Trace Reviewer, Label Reviewer, Playbook Author, Curator roles
```

Exit criteria:

```text
high-signal trigger creates learning task
trace can be materialized and reviewed
trace can be labeled for diagnosis/replay/quarantine
playbook can be drafted, reviewed, activated, archived
curation report can merge/archive derived artifacts
```

### Phase 4: high-authority proposal and replay workflows

Goals:

```text
implement composite patch proposal workflow
implement deterministic replay workflow
implement regression/counterfactual evaluation workflow
implement Patch Author, Evaluator Runner, Evaluation Steward roles
```

Exit criteria:

```text
policy patch bundle can be drafted
risk facets are explicit
replay report generated
eval report generated
low-N claims classified by evidence grade
```

### Phase 5: promotion, rollback, and audit workflows

Goals:

```text
implement patch promotion workflow
implement rollback workflow
implement learning audit workflow
implement Promotion Reviewer and Learning Auditor roles
```

Exit criteria:

```text
high-authority patch can be staged/promoted/rejected through ACP
role separation enforced
rollback can be requested and executed
auditor can quarantine suspicious learning artifacts
```

### Phase 6: learning-workflow self-improvement governance

Goals:

```text
implement learning_workflow_patch.v1
allow proposed changes to learning workflows only for future versions
require external review for evaluator, authority, label, and taxonomy changes
```

Exit criteria:

```text
learning workflow patch cannot modify its own active definition
meta-evaluation report is required
promotion applies only to future workflow version
```

### Implementation completion status

Status: Complete as of 2026-05-11.

Completed checkpoints:

- [x] Phase 1: ACP/HRC capture foundation.
- [x] Phase 2: deterministic workflow replay.
- [x] Phase 3: low-authority learning workflows.
- [x] Phase 4: high-authority proposal and replay workflows.
- [x] Phase 5: promotion, rollback, and audit workflows.
- [x] Phase 6: learning-workflow self-improvement governance.
- [x] `wlearn` downstream tooling.

Implementation notes:

- ACP workflow events now include schema version, workflow sequence, command hash,
  event hash, previous hash, accepted/rejected/recorded result, rejection code,
  actor/role/authority metadata, and causation/correlation fields.
- ACP persists `WorkflowHrcRunMap` records and writes mapping events for launch
  or reconciled ACP/HRC run correlation.
- Effect lifecycle changes are ledgered with `effect.intent.leased`,
  `effect.intent.delivered`, `effect.intent.failed`, and
  `effect.intent.unsupported` events. Unsupported effects are not silently
  marked delivered.
- Learning workflow presets live in ACP under `learning_*` workflow IDs and
  `learning-task/*` kinds. They cover trace triage, trace labeling, playbook
  update, curation, policy patch, patch evaluation, patch promotion, rollback,
  audit, and learning-workflow patch governance.
- `wlearn` is implemented as read-only/downstream tooling for trace
  materialization, replay reports, HRC range summaries, playbook/patch drafts,
  curation reports, and promotion-readiness submission. It does not own
  lifecycle state or promotion authority.

Justified spec adjustments:

- Rejected commands against unknown task IDs cannot be appended to a
  task-scoped workflow stream because no workflow task identity is available.
  Rejections are ledgered once the target task exists.
- Deterministic replay validates event integrity and recorded kernel outcomes
  from replay-grade events. It intentionally does not attempt bit-identical LLM
  replay or statistical Grade C operational claims.
- External authority is represented as ACP role/evidence requirements; concrete
  organizational authority binding remains deployment policy.

Validation recorded in `HEURISTIC_LEARNING_IMPLEMENTATION.md`:

- `bun run --filter acp-core typecheck`
- `bun run --filter acp-core test`
- `bun run --filter acp-state-store typecheck`
- `bun run --filter acp-state-store test`
- `bun run --filter acp-server typecheck`
- `bun test packages/acp-server/test/workflow-tasks.test.ts`
- `bun test packages/acp-server/test/workflow-participant-runs.test.ts`
- `bun run --filter wlearn typecheck`
- `bun run --filter wlearn test`
- `bun run lint`
- `bun run test`
- Manual `wlearn trace materialize` and `wlearn replay run` smoke tests against
  a generated ACP workflow snapshot.

---

## 17. Minimum Viable Vertical Slice

The MVP should not attempt full statistical workflow optimization.

MVP scope:

```text
1. ACP event-sources one workflow task.
2. ACP records one accepted transition and one rejected transition.
3. ACP records one HRC participant mapping.
4. HRC provides the run/tool/turn range.
5. wlearn materializes one trace.
6. wlearn replays deterministic workflow outcomes.
7. ACP learning_trace_triage reviews the trace.
8. ACP learning_playbook_update activates one low-authority playbook.
9. ACP learning_policy_patch drafts one high-authority patch but does not promote it.
```

MVP non-goals:

```text
automatic policy promotion
statistical success-rate claims
bit-identical LLM replay
full hash-chain sealing
full compression algorithm
self-modifying evaluator
```

---

## 18. Success Metrics

### Capture metrics

```text
percentage of workflow commands with events
percentage of rejected commands with rejection events
percentage of participant runs mapped to HRC runs
percentage of effect outcomes ledgered
malformed trace count
quarantined trace count
```

### Replay metrics

```text
kernel replay pass rate
number of deterministic divergences
number of regression traces available
number of counterfactual cases available
```

### Low-authority learning metrics

```text
trace triage throughput
playbooks activated
playbooks archived or merged
conflicting guidance detected
time from trigger to guidance
rate of no-op reports
```

### High-authority learning metrics

```text
patch bundles proposed
patch bundles rejected as unevaluable
replay pass/fail/inconclusive counts
promotion requests
rollbacks
human/external authority interventions
```

### Goodhart monitoring metrics

```text
anomaly rate changes
waiver rate changes
humanOverride rate changes
task taxonomy drift
evidence semantic validation failure rate
trusted-label source distribution
evaluator suite changes
promotion-role separation violations
```

---

## 19. Open Design Questions

1. What is the minimum ACP event schema that supports replay without overfitting to current implementation details?
2. Which HRC event categories are mandatory for trace materialization and which are best-effort?
3. What redaction policy applies to rejected-command payloads and HRC ranges?
4. Which low-authority guidance artifacts may become active without human review?
5. What threshold escalates playbook findings into high-authority patch candidates?
6. What evaluator suites are frozen historical suites, and who owns them?
7. How are task taxonomy changes reviewed to prevent Goodhart by reclassification?
8. What constitutes enough evidence for Grade C operational improvement claims?
9. How should curation detect conflicting guidance automatically?
10. What are the operator procedures for ledger migration, projection rebuild, and trace quarantine?

---

## 20. Final Boundary Statement

The system should be built around this rule:

> Learning work is ACP work. Learning tools are `wlearn` tools. Runtime traces are HRC records. Workflow authority remains ACP authority.

The best first product is not automatic workflow self-modification. It is:

```text
complete workflow event capture
HRC correlation
deterministic workflow replay
trace triage
low-authority playbook learning
curation and compression
governed high-authority patch proposal
evaluation and promotion under ACP role separation
```

This gives the system a path to absorb feedback without giving the learner control over its own success signal.

---

## Appendix A: Reference

Jiayi Weng, *Learning Beyond Gradients*, 2026. <https://trinkle23897.github.io/learning-beyond-gradients/>
