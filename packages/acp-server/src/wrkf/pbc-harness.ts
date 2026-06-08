/**
 * PBC harness Phase 5 — orchestrator.
 *
 * SPEC §4.7 (result model), §4.11 (run lifecycle), §4.12 (transition application),
 * §4.13 (PBC state policy table), §4.17 (autopilot algorithm).
 *
 * Three operations, all returning a normalized {@link PbcHarnessResult}:
 *
 *   runStep            — one participant action. Starts a wrkf run, ingests the
 *                        supplied participant output (via P4.5
 *                        captureAndIngestParticipantOutput — idempotent), finishes
 *                        the run, and applies a transition ONLY when
 *                        transitionPolicy='single-safe' selects exactly one legal
 *                        action. Effects are delivered after a committed transition.
 *                        In launchRuntime mode there is no output yet — the run is
 *                        started and the harness returns immediately ('launched'),
 *                        applying no transition and never finishing the run.
 *
 *   approveTransition  — one operator-approved transition with fresh CAS. Re-reads
 *                        next immediately before apply, uses the fresh
 *                        revision+contextHash, a deterministic idempotency key
 *                        `{routeKey}:transition:{transition}:{revision}`, and
 *                        single-retries once on a stale-revision / context-mismatch.
 *
 *   runUntilBlocked    — conservative autopilot per §4.17 + the §4.13 state policy
 *                        table. Stops on: closed, stale_instance,
 *                        requires_product_owner_clarification,
 *                        requires_product_owner_patch_decision, blocked_or_ambiguous,
 *                        requires_distinct_pressure_reviewer, max_turns.
 *
 * Locked invariants (daedalus):
 *   - run.finish is called ONLY after evidence/obligation ingestion succeeds, and
 *     NEVER receives evidenceRefs / outcome / an idempotency key (status?+summary?
 *     only). On ingest failure the run is failed (run.fail) and the error rethrown.
 *   - No transition is applied before participant output is ingested.
 *   - `next` is re-read after every evidence/obligation/effect write before a
 *     transition; legality is never inferred from local state.
 *   - Separation of duty: the pressure_pass actor MUST differ from the pbc_draft
 *     actor for finalization transitions; otherwise autopilot stops with
 *     requires_distinct_pressure_reviewer and applies nothing.
 *   - Disposition transitions (dispose_from_*) are never chosen by autopilot unless
 *     allowDisposition=true.
 *   - The result always carries the freshest known revision + contextHash.
 *
 * This module COMPOSES existing P2/P3/P4/P4.5 modules; it does not re-implement
 * evidence ingestion, capture idempotency, or effect delivery.
 */

import { deliverPbcEffects } from './effect-delivery.js'
import {
  ingestEvidenceAndSatisfyObligations,
  type ParticipantOutput,
} from './pbc-evidence.js'
import {
  captureAndIngestParticipantOutput,
  makeParticipantOutputCaptureKey,
  type ParticipantOutputPort,
} from './participant-output.js'
import {
  projectNextActionResponse,
  type NextActionResponse,
} from './projections.js'

const WORKFLOW_REF = 'pbc-progressive-refinement@5'
const DEFAULT_MAX_TURNS = 50
const CAS_RETRY_ERROR_CODES = ['WRKF_STALE_REVISION', 'WRKF_CONTEXT_MISMATCH']

// ---------------------------------------------------------------------------
// Port — composition of every wrkf surface the orchestrator touches.
// ParticipantOutputPort already supplies next / evidence.add / obligation.* /
// captures.*; we add run / transition / effect.
// ---------------------------------------------------------------------------

export interface PbcHarnessPort extends ParticipantOutputPort {
  run: {
    start(params: {
      task: string
      role: string
      actor?: unknown
      idempotencyKey?: string
      lane?: string
      deliveryRef?: string
    }): Promise<unknown>
    finish(params: { runId: string; status?: string; summary?: string }): Promise<unknown>
    fail(params: { runId: string; summary?: string }): Promise<unknown>
    bindExternal(params: Record<string, unknown>): Promise<unknown>
  }
  transition: {
    apply(params: {
      task: string
      transition: string
      role?: string
      actor?: unknown
      expectRevision?: number
      contextHash?: string
      idempotencyKey?: string
      runChecks?: boolean
      dryRun?: boolean
    }): Promise<unknown>
  }
  effect: {
    list(params: { task: string }): Promise<unknown>
    deliver(params: { effectId: string; adapter: string }): Promise<unknown>
  }
}

// ---------------------------------------------------------------------------
// Request / response contracts (SPEC §4.6.2 / §4.6.3 / §4.6.4 / §4.7)
// ---------------------------------------------------------------------------

export type TransitionPolicy = 'none' | 'single-safe'

export interface RunStepRequest {
  task: string
  role?: string
  actor: string
  idempotencyKey: string
  launchRuntime?: boolean
  participantOutput?: ParticipantOutput
  transitionPolicy?: TransitionPolicy
  scopeRef?: string
  laneRef?: string
}

export interface ApproveTransitionRequest {
  task: string
  transition: string
  role?: string
  actor: string
  routeKey: string
  runChecks?: boolean
}

export interface RunUntilBlockedRequest {
  task: string
  actor: string
  pressureActor?: string
  productOwnerActor?: string
  idempotencyKey: string
  maxTurns?: number
  allowDisposition?: boolean
  allowProductOwnerSimulation?: boolean
}

export interface PbcHarnessResult {
  task: string
  workflowRef: 'pbc-progressive-refinement@5'
  instance: {
    status: string
    phase: string
    revision: number
    contextHash: string
    stale?: boolean
  }
  next: {
    actions: unknown[]
    blockedTransitions: unknown[]
    openObligations: unknown[]
    pendingEffects: unknown[]
  }
  runs: {
    started?: unknown
    boundExternal?: unknown
    finished?: unknown
    failed?: unknown
  }
  evidenceAdded: unknown[]
  obligationsSatisfied: unknown[]
  transitionApplied?: unknown
  effectsDelivered: unknown[]
  stopReason?: string
  diagnostics: string[]
}

// ---------------------------------------------------------------------------
// runStep
// ---------------------------------------------------------------------------

export async function runStep(
  port: PbcHarnessPort,
  input: RunStepRequest
): Promise<PbcHarnessResult> {
  const role = input.role ?? 'agent'
  const transitionPolicy: TransitionPolicy = input.transitionPolicy ?? 'none'
  const launchRuntime = input.launchRuntime === true
  const result = emptyResult(input.task)

  // 1. Read current state (revision/contextHash sourced from next.instance).
  let latestNext = await readNext(port, input.task, role)
  applyNext(result, latestNext)

  // 2. Start the wrkf run (wire name `task`, never `taskId`).
  const startedRun = await port.run.start({
    task: input.task,
    role,
    actor: input.actor,
    idempotencyKey: `${input.idempotencyKey}:run:${latestNext.instance.revision}`,
    ...(input.scopeRef !== undefined ? { deliveryRef: input.scopeRef } : {}),
    ...(input.laneRef !== undefined ? { lane: input.laneRef } : {}),
  })
  result.runs.started = startedRun

  // 3a. launchRuntime mode: no participant output yet. Do NOT finish the run and
  //     do NOT apply a transition — the runtime delivers output later (P4.5).
  if (launchRuntime) {
    result.diagnostics.push('launched-runtime: awaiting participant output')
    return result
  }

  // 3b. supplied mode: ingest participant output (idempotent via captures), then
  //     finish the run ONLY after ingestion succeeds. Fail the run on any error.
  const runId = recordId(startedRun)
  const captureKey = makeParticipantOutputCaptureKey(input.idempotencyKey, input.task)
  try {
    const capture = await captureAndIngestParticipantOutput(port, {
      task: input.task,
      role,
      actor: input.actor,
      captureKey,
      mode: 'supplied',
      participantOutput: input.participantOutput ?? { evidence: [] },
    })
    result.evidenceAdded = capture.evidenceAdded
    result.obligationsSatisfied = capture.obligationsSatisfied
    if (capture.next !== undefined) {
      latestNext = capture.next
      applyNext(result, latestNext)
    }

    // run.finish: status?+summary? ONLY. Never evidenceRefs/outcome/idempotencyKey.
    result.runs.finished = await port.run.finish({
      runId,
      status: 'completed',
      ...(input.participantOutput?.summary !== undefined
        ? { summary: input.participantOutput.summary }
        : {}),
    })
  } catch (error) {
    result.runs.failed = await port.run.fail({ runId })
    throw error
  }

  // 4. transitionPolicy=single-safe: apply iff exactly one legal, non-disposition
  //    action is available in the freshest next read.
  if (transitionPolicy === 'single-safe') {
    const transition = chooseSingleSafeTransition(latestNext, false)
    if (transition !== undefined) {
      result.transitionApplied = await port.transition.apply({
        task: input.task,
        transition,
        role,
        actor: input.actor,
        expectRevision: latestNext.instance.revision,
        contextHash: latestNext.instance.contextHash ?? '',
        idempotencyKey: `${input.idempotencyKey}:transition:${transition}:${latestNext.instance.revision}`,
        runChecks: false,
      })

      // Deliver effects AFTER the committed transition.
      result.effectsDelivered.push(...(await deliverEffects(port, input.task)))

      // Re-read so the result carries the freshest revision/contextHash.
      latestNext = await readNext(port, input.task, role)
      applyNext(result, latestNext)
    }
  }

  return result
}

// ---------------------------------------------------------------------------
// approveTransition
// ---------------------------------------------------------------------------

export async function approveTransition(
  port: PbcHarnessPort,
  input: ApproveTransitionRequest
): Promise<PbcHarnessResult> {
  const role = input.role ?? 'agent'
  const runChecks = input.runChecks ?? false
  const result = emptyResult(input.task)

  // 1. Re-read next immediately before apply (fresh CAS).
  let fresh = await readNext(port, input.task, role)
  applyNext(result, fresh)

  // 2. Apply with a single CAS retry on stale-revision / context-mismatch.
  let applied: unknown
  let retried = false
  for (;;) {
    try {
      applied = await port.transition.apply({
        task: input.task,
        transition: input.transition,
        role,
        actor: input.actor,
        expectRevision: fresh.instance.revision,
        contextHash: fresh.instance.contextHash ?? '',
        idempotencyKey: `${input.routeKey}:transition:${input.transition}:${fresh.instance.revision}`,
        runChecks,
      })
      break
    } catch (error) {
      if (!retried && isCasRetryError(error)) {
        retried = true
        fresh = await readNext(port, input.task, role)
        applyNext(result, fresh)
        continue
      }
      throw error
    }
  }
  result.transitionApplied = applied

  // 3. Deliver effects after the committed transition.
  result.effectsDelivered.push(...(await deliverEffects(port, input.task)))

  // 4. Re-read so the result carries the freshest revision/contextHash.
  const latest = await readNext(port, input.task, role)
  applyNext(result, latest)

  return result
}

// ---------------------------------------------------------------------------
// runUntilBlocked (autopilot — SPEC §4.17 + state policy table §4.13)
// ---------------------------------------------------------------------------

export async function runUntilBlocked(
  port: PbcHarnessPort,
  input: RunUntilBlockedRequest
): Promise<PbcHarnessResult> {
  const maxTurns = input.maxTurns ?? DEFAULT_MAX_TURNS
  const allowDisposition = input.allowDisposition === true
  const allowProductOwnerSimulation = input.allowProductOwnerSimulation === true
  const result = emptyResult(input.task)
  let stopReason: string | undefined

  let turns = 0
  while (turns < maxTurns) {
    turns++

    const next = await readNext(port, input.task, 'agent')
    applyNext(result, next)

    if (next.instance.state.status === 'closed') {
      stopReason = 'closed'
      break
    }
    if (next.instance.stale === true) {
      stopReason = 'stale_instance'
      break
    }

    const state = `${next.instance.state.status}/${next.instance.state.phase}`

    // ── Product-owner waiting states ────────────────────────────────────────
    if (state === 'waiting/clarification') {
      if (!allowProductOwnerSimulation) {
        stopReason = 'requires_product_owner_clarification'
        break
      }
      const fresh = await runProductOwnerStep(port, input, result, 'clarification', next)
      const outcome = await applyAutopilotTransition(port, input, result, fresh, allowDisposition)
      if (outcome !== 'applied') {
        stopReason = outcome
        break
      }
      continue
    }

    if (state === 'waiting/patch_decision') {
      if (!allowProductOwnerSimulation) {
        stopReason = 'requires_product_owner_patch_decision'
        break
      }
      const fresh = await runProductOwnerStep(port, input, result, 'patch_decision', next)
      const outcome = await applyAutopilotTransition(port, input, result, fresh, allowDisposition)
      if (outcome !== 'applied') {
        stopReason = outcome
        break
      }
      continue
    }

    // ── Agent participant action ────────────────────────────────────────────
    // Re-read next after the (composed) participant action before applying a
    // transition — legality is authoritative from wrkf, never local state.
    const fresh = await readNext(port, input.task, 'agent')
    applyNext(result, fresh)
    const outcome = await applyAutopilotTransition(port, input, result, fresh, allowDisposition)
    if (outcome !== 'applied') {
      stopReason = outcome
      break
    }
  }

  result.stopReason = stopReason ?? 'max_turns'
  return result
}

// ---------------------------------------------------------------------------
// Autopilot helpers
// ---------------------------------------------------------------------------

type AutopilotOutcome = 'applied' | 'blocked_or_ambiguous' | 'requires_distinct_pressure_reviewer'

async function applyAutopilotTransition(
  port: PbcHarnessPort,
  input: RunUntilBlockedRequest,
  result: PbcHarnessResult,
  fresh: NextActionResponse,
  allowDisposition: boolean
): Promise<AutopilotOutcome> {
  const transition = chooseSingleSafeTransition(fresh, allowDisposition)
  if (transition === undefined) {
    return 'blocked_or_ambiguous'
  }

  if (isFinalizationTransition(transition) && !hasDistinctPressureActor(input)) {
    return 'requires_distinct_pressure_reviewer'
  }

  result.transitionApplied = await port.transition.apply({
    task: input.task,
    transition,
    role: 'agent',
    actor: actorForTransition(transition, input),
    expectRevision: fresh.instance.revision,
    contextHash: fresh.instance.contextHash ?? '',
    idempotencyKey: `${input.idempotencyKey}:transition:${transition}:${fresh.instance.revision}`,
    runChecks: false,
  })

  result.effectsDelivered.push(...(await deliverEffects(port, input.task)))
  return 'applied'
}

/**
 * Simulate the product-owner obligation step (clarification / patch decision):
 * ingest the product-owner evidence, satisfy the obligation, and re-read next.
 * Only reached when allowProductOwnerSimulation is enabled.
 */
async function runProductOwnerStep(
  port: PbcHarnessPort,
  input: RunUntilBlockedRequest,
  result: PbcHarnessResult,
  kind: 'clarification' | 'patch_decision',
  next: NextActionResponse
): Promise<NextActionResponse> {
  const actor = input.productOwnerActor ?? input.actor
  const participantOutput: ParticipantOutput =
    kind === 'clarification'
      ? {
          evidence: [
            {
              kind: 'clarification_response',
              summary: 'autopilot product-owner clarification (simulation)',
            },
          ],
          satisfyObligations: [{ obligationKind: 'clarification_response', evidenceIndex: 0 }],
        }
      : {
          evidence: [{ kind: 'patch_decision', facts: { route: patchRouteFromNext(next) } }],
          satisfyObligations: [{ obligationKind: 'patch_decision', evidenceIndex: 0 }],
        }

  const ingest = await ingestEvidenceAndSatisfyObligations(port, {
    task: input.task,
    role: 'product_owner',
    actor,
    allowProductOwnerSimulation: true,
    participantOutput,
  })
  result.evidenceAdded.push(...ingest.evidenceAdded)
  result.obligationsSatisfied.push(...ingest.obligationsSatisfied)
  applyNext(result, ingest.next)
  return ingest.next
}

function patchRouteFromNext(next: NextActionResponse): 'finalize' | 'revise' {
  const transitions = next.actions.map((a) => a.transition)
  const hasFinalize = transitions.includes('finalize_after_patch_decision')
  const hasRevise = transitions.includes('revise_after_patch_decision')
  return hasRevise && !hasFinalize ? 'revise' : 'finalize'
}

// ---------------------------------------------------------------------------
// Transition selection / policy helpers
// ---------------------------------------------------------------------------

function chooseSingleSafeTransition(
  next: NextActionResponse,
  allowDisposition: boolean
): string | undefined {
  const candidates = next.actions
    .map((a) => a.transition)
    .filter((t): t is string => typeof t === 'string')
    .filter((t) => allowDisposition || !isDispositionTransition(t))
  return candidates.length === 1 ? candidates[0] : undefined
}

function isDispositionTransition(transition: string): boolean {
  return transition.startsWith('dispose_')
}

function isFinalizationTransition(transition: string): boolean {
  return transition === 'finalize_ready_pbc' || transition === 'finalize_after_patch_decision'
}

function hasDistinctPressureActor(input: RunUntilBlockedRequest): boolean {
  return input.pressureActor !== undefined && input.pressureActor !== input.actor
}

function actorForTransition(transition: string, input: RunUntilBlockedRequest): string {
  if (isFinalizationTransition(transition) && input.pressureActor !== undefined) {
    return input.pressureActor
  }
  return input.actor
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

async function readNext(
  port: PbcHarnessPort,
  task: string,
  role?: string
): Promise<NextActionResponse> {
  const raw = await port.next({ task, ...(role !== undefined ? { role } : {}) })
  return projectNextActionResponse(raw)
}

async function deliverEffects(port: PbcHarnessPort, task: string): Promise<Array<{ id: string }>> {
  const delivery = await deliverPbcEffects(port, { task })
  return delivery.delivered.map((id) => ({ id }))
}

function applyNext(result: PbcHarnessResult, next: NextActionResponse): void {
  const instance = next.instance
  result.instance = {
    status: instance.state.status,
    phase: instance.state.phase,
    revision: instance.revision,
    contextHash: instance.contextHash ?? '',
    ...(instance.stale !== undefined ? { stale: instance.stale } : {}),
  }
  result.next = {
    actions: next.actions,
    blockedTransitions: next.blockedTransitions,
    openObligations: next.openObligations,
    pendingEffects: next.pendingEffects,
  }
}

function emptyResult(task: string): PbcHarnessResult {
  return {
    task,
    workflowRef: WORKFLOW_REF,
    instance: { status: '', phase: '', revision: 0, contextHash: '' },
    next: { actions: [], blockedTransitions: [], openObligations: [], pendingEffects: [] },
    runs: {},
    evidenceAdded: [],
    obligationsSatisfied: [],
    effectsDelivered: [],
    diagnostics: [],
  }
}

function recordId(record: unknown): string {
  if (typeof record === 'object' && record !== null) {
    const id = (record as Record<string, unknown>)['id']
    if (typeof id === 'string') {
      return id
    }
  }
  return ''
}

function isCasRetryError(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) {
    return false
  }
  const maybe = error as { code?: unknown; message?: unknown }
  if (typeof maybe.code === 'string' && CAS_RETRY_ERROR_CODES.includes(maybe.code)) {
    return true
  }
  if (
    typeof maybe.message === 'string' &&
    CAS_RETRY_ERROR_CODES.some((code) => (maybe.message as string).includes(code))
  ) {
    return true
  }
  return false
}
