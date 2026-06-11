/**
 * POST /v1/pbc/tasks/:taskId/input — human product-owner input (Phase 3).
 *
 * kind ∈ { 'clarification_response', 'patch_decision' }. The acting actor comes
 * from auth/middleware (x-acp-actor), NEVER the body. The agent role can NEVER
 * submit product-owner input (enforced here + by the PBC evidence policy).
 *
 * Body carries FORM DATA only — no raw transition IDs / contextHash / obligation
 * wire shapes. The server maps the form input to evidence via the PBC pack,
 * satisfies the matching obligation, and applies the legal transition itself.
 */

import type { Actor } from 'acp-core'

import { forbidden, json, unprocessable } from '../http.js'
import {
  isRecord,
  parseJsonBody,
  requireRecord,
  requireTrimmedStringField,
} from '../parsers/body.js'
import type { RouteHandler } from '../routing/route-context.js'
import { mapPbcHumanInput } from '../wrkf/packs/pbc/output-parser.js'
import type { AcpWrkfWorkflowPort } from '../wrkf/port.js'
import { type NextActionResponse, projectObligationRecord } from '../wrkf/projections.js'
import { applyFreshTransition } from '../wrkf/transition-apply.js'

import { buildPbcTaskProjection, deriveScreen } from './projection.js'
import {
  admitPbcContinuationJob,
  deliverPbcEffects,
  isAdmissibleForContinuation,
  mapPbcRouteError,
  readPbcEvidence,
  readPbcNext,
  requirePbcStateStore,
  requirePbcTaskId,
  requirePbcWrkf,
  wrkfActorString,
} from './shared.js'

/** Which input kind a given product screen accepts. */
function acceptedKindForScreen(screen: string): string | undefined {
  if (screen === 'clarification') {
    return 'clarification_response'
  }
  if (screen === 'patch_decision') {
    return 'patch_decision'
  }
  return undefined
}

/** Transition to apply for a satisfied input on the current screen. */
function transitionForInput(screen: string, route: string | undefined): string {
  if (screen === 'clarification') {
    return 'answer_clarification'
  }
  return route === 'revise' ? 'revise_after_patch_decision' : 'finalize_after_patch_decision'
}

function inputText(kind: string, data: Record<string, unknown>): string {
  if (kind === 'clarification_response') {
    return typeof data['answer'] === 'string' ? data['answer'] : ''
  }
  return typeof data['route'] === 'string' ? data['route'] : 'finalize'
}

function recordId(result: unknown): string | undefined {
  return isRecord(result) && typeof result['id'] === 'string' ? result['id'] : undefined
}

async function findObligationId(
  wrkf: AcpWrkfWorkflowPort,
  taskId: string,
  next: NextActionResponse,
  kind: string
): Promise<string | undefined> {
  const listed = await wrkf.obligation.list({ task: taskId })
  const records = Array.isArray(listed)
    ? listed.map((entry, index) => projectObligationRecord(entry, `obligation[${index}]`))
    : next.openObligations
  const match = records.find(
    (obligation) => obligation.kind === kind && obligation.status === 'open'
  )
  return match?.id ?? next.openObligations.find((o) => o.kind === kind)?.id
}

export const handlePbcInput: RouteHandler = async (context) => {
  const taskId = requirePbcTaskId(context.params)
  const wrkf = requirePbcWrkf(context.deps)
  const stateStore = requirePbcStateStore(context.deps)

  const actor: Actor = context.actor ?? context.deps.defaultActor
  if (actor.kind === 'agent') {
    forbidden('actor_forbidden', 'agent role may not submit product-owner input')
  }
  const actorString = wrkfActorString(actor)

  const body = requireRecord(await parseJsonBody(context.request))
  const kind = requireTrimmedStringField(body, 'kind')
  // Validate up-front, BEFORE any wrkf writes — parsing this only at job
  // admission half-applied the input (evidence + transition committed, then
  // 400) and left the workflow advanced but stalled (T-04112).
  const idempotencyKey = requireTrimmedStringField(body, 'idempotencyKey')
  const data = isRecord(body['data']) ? (body['data'] as Record<string, unknown>) : {}

  try {
    const next = await readPbcNext(wrkf, taskId)
    const screen = deriveScreen(next.instance.state.status, next.instance.state.phase)
    const accepted = acceptedKindForScreen(screen)
    if (accepted === undefined || accepted !== kind) {
      unprocessable(
        'WRONG_SCREEN_KIND',
        `current screen "${screen}" does not accept input kind "${kind}"`
      )
    }

    // Map form input → evidence via the PBC pack (no raw wire shapes from body).
    const text = inputText(kind, data)
    const mapped = await mapPbcHumanInput({
      text,
      data,
      role: 'product_owner',
      actor: actorString,
      next,
    })

    const evidenceIds: Array<string | undefined> = []
    for (const evidence of mapped.evidence) {
      const result = await wrkf.evidence.add({
        task: taskId,
        kind: evidence.kind,
        actor: actorString,
        role: 'product_owner',
        ...(evidence.summary !== undefined ? { summary: evidence.summary } : {}),
        ...(evidence.facts !== undefined ? { facts: evidence.facts } : {}),
      })
      evidenceIds.push(recordId(result))
    }

    for (const directive of mapped.satisfyObligations ?? []) {
      const obligationKind = directive.obligationKind ?? kind
      const obligationId =
        directive.obligationId ?? (await findObligationId(wrkf, taskId, next, obligationKind))
      if (obligationId === undefined) {
        continue
      }
      const evidenceId = evidenceIds[directive.evidenceIndex]
      await wrkf.obligation.satisfy({
        task: taskId,
        id: obligationId,
        actor: actorString,
        role: 'product_owner',
        ...(evidenceId !== undefined ? { evidenceId } : {}),
      })
    }

    const route = kind === 'patch_decision' ? inputText(kind, data) : undefined
    const transition = transitionForInput(screen, route)
    // Re-read wrkf.next AFTER the evidence + obligation writes (both bump the
    // wrkf context) so the transition applies with the FRESH revision/contextHash.
    // applyFreshTransition does the re-read + a single CAS retry on stale mismatch.
    await applyFreshTransition(wrkf, {
      task: taskId,
      transition,
      role: 'product_owner',
      actor: actorString,
      routeKey: taskId,
      runChecks: false,
      assertLegal: false,
    })

    await deliverPbcEffects(wrkf, taskId)

    const after = await readPbcNext(wrkf, taskId)
    const job = isAdmissibleForContinuation(after)
      ? admitPbcContinuationJob(stateStore, {
          taskId,
          revision: after.instance.revision,
          idempotencyKey,
        })
      : undefined

    const evidence = await readPbcEvidence(wrkf, taskId)
    return json(buildPbcTaskProjection({ taskId, next: after, job, evidence }), 200)
  } catch (error) {
    throw mapPbcRouteError(error)
  }
}
