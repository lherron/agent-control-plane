import { type SessionRef, normalizeSessionRef } from 'agent-scope'
import {
  type AppendEventResult,
  type CoordinationStore,
  type ParticipantRef,
  appendEvent,
} from 'coordination-substrate'

import { isRecord } from '../parsers/body.js'
import type { AcpWrkfWorkflowPort } from '../wrkf/port.js'

const SUPPORTED_EFFECT_KINDS = ['wake_role', 'request_observer_review'] as const
const DEFAULT_CLAIM_LIMIT = 50
const DEFAULT_LEASE_MS = 60_000
const UNSUPPORTED_EFFECT_KIND = 'unsupported_effect_kind'
const DEFAULT_AGENT_TASKER_ROLE_BINDINGS: Record<string, WrkfRoleBinding> = {
  architect: { kind: 'agent', id: 'cody' },
  coordinator: { kind: 'agent', id: 'clod' },
  implementer: { kind: 'agent', id: 'larry' },
  observer: { kind: 'agent', id: 'observer' },
  red_author: { kind: 'agent', id: 'smokey' },
}

export type WrkfRoleBinding = {
  kind: string
  id: string
}

export type WrkfEffectReconcileDeps = {
  wrkf: AcpWrkfWorkflowPort
  coordStore: CoordinationStore
  taskId: string
  projectId?: string | undefined
  roleBindings?: Record<string, WrkfRoleBinding> | undefined
  limit?: number | undefined
  leaseMs?: number | undefined
}

export type WrkfEffectReconcileResult = {
  scanned: number
  delivered: Array<{ effectId: string; kind: string }>
  failed: Array<{ effectId: string; kind: string; reason: string; retryable: boolean }>
}

type WrkfEffect = {
  id: string
  kind: string
  payload?: unknown
  idempotencyKey?: string | undefined
}

type ClaimResponse = {
  effects: WrkfEffect[]
  leaseToken: string
}

type TaskContext = {
  projectId: string
  roleBindings: Record<string, WrkfRoleBinding>
}

function optionalString(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key]
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

function readRoleBindings(value: unknown): Record<string, WrkfRoleBinding> {
  if (!isRecord(value)) {
    return {}
  }
  const bindings: Record<string, WrkfRoleBinding> = {}
  for (const [role, actor] of Object.entries(value)) {
    if (!isRecord(actor)) {
      continue
    }
    const kind = optionalString(actor, 'kind')
    const id = optionalString(actor, 'id')
    if (kind !== undefined && id !== undefined) {
      bindings[role] = { kind, id }
    }
  }
  return bindings
}

function inspectTaskRecord(inspected: unknown): Record<string, unknown> {
  if (!isRecord(inspected)) {
    return {}
  }
  const nested = inspected['task']
  return isRecord(nested) ? nested : inspected
}

async function resolveTaskContext(deps: WrkfEffectReconcileDeps): Promise<TaskContext> {
  const inspected = inspectTaskRecord(await deps.wrkf.task.inspect({ task: deps.taskId }))
  return {
    projectId: deps.projectId ?? optionalString(inspected, 'projectId') ?? '',
    roleBindings: {
      ...DEFAULT_AGENT_TASKER_ROLE_BINDINGS,
      ...readRoleBindings(inspected['roleBindings']),
      ...(deps.roleBindings ?? {}),
    },
  }
}

function parseClaimResponse(value: unknown): ClaimResponse {
  if (!isRecord(value)) {
    return { effects: [], leaseToken: '' }
  }
  const rawEffects = value['effects']
  const effects = Array.isArray(rawEffects) ? (rawEffects as WrkfEffect[]) : []
  const leaseToken = typeof value['leaseToken'] === 'string' ? value['leaseToken'] : ''
  return { effects, leaseToken }
}

function effectId(effect: WrkfEffect): string {
  return typeof effect.id === 'string' ? effect.id : ''
}

function effectKind(effect: WrkfEffect): string {
  return typeof effect.kind === 'string' ? effect.kind : ''
}

function effectPayload(effect: WrkfEffect): Record<string, unknown> | undefined {
  return isRecord(effect.payload) ? effect.payload : undefined
}

function effectIdempotencyKey(effect: WrkfEffect): string {
  return (
    (typeof effect.idempotencyKey === 'string' && effect.idempotencyKey.length > 0
      ? effect.idempotencyKey
      : undefined) ?? effectId(effect)
  )
}

function systemParticipant(id: string): ParticipantRef {
  return { kind: 'system', id }
}

function sessionParticipant(sessionRef: SessionRef): ParticipantRef {
  return { kind: 'session', sessionRef }
}

function buildReason(input: { taskId: string; role: string; payload: Record<string, unknown> }) {
  return (
    optionalString(input.payload, 'reason') ??
    `Workflow task ${input.taskId} requested ${input.role}`
  )
}

function buildInstructionBody(input: {
  kind: string
  reason: string
  payload: Record<string, unknown>
}): string {
  const data = isRecord(input.payload['data']) ? input.payload['data'] : undefined
  const instruction = data === undefined ? undefined : optionalString(data, 'instruction')
  return instruction ?? input.reason
}

function buildMeta(input: {
  effect: WrkfEffect
  role: string
  payload: Record<string, unknown>
}): Record<string, unknown> {
  const data = isRecord(input.payload['data']) ? input.payload['data'] : undefined
  return {
    workflowEffectId: effectId(input.effect),
    workflowEffectKind: effectKind(input.effect),
    role: input.role,
    ...(data !== undefined && Array.isArray(data['guardrails'])
      ? { guardrails: data['guardrails'] }
      : {}),
    ...(data !== undefined && optionalString(data, 'targetLane') !== undefined
      ? { targetLane: optionalString(data, 'targetLane') }
      : {}),
  }
}

function buildWakeCommand(input: {
  coordStore: CoordinationStore
  taskId: string
  context: TaskContext
  effect: WrkfEffect
}): AppendEventResult {
  const payload = effectPayload(input.effect)
  const role = payload === undefined ? undefined : optionalString(payload, 'role')
  if (payload === undefined || role === undefined) {
    throw new Error(UNSUPPORTED_EFFECT_KIND)
  }

  const actor = input.context.roleBindings[role]
  if (actor === undefined || actor.kind !== 'agent' || actor.id.length === 0) {
    throw new Error(UNSUPPORTED_EFFECT_KIND)
  }

  const sessionRef = normalizeSessionRef({
    scopeRef: `agent:${actor.id}:project:${input.context.projectId}:task:${input.taskId}:role:${role}`,
    laneRef: 'main',
  })
  const sourceActor = systemParticipant('wrkf')
  const target = sessionParticipant(sessionRef)
  const reason = buildReason({ taskId: input.taskId, role, payload })

  return appendEvent(input.coordStore, {
    projectId: input.context.projectId,
    idempotencyKey: effectIdempotencyKey(input.effect),
    event: {
      ts: new Date().toISOString(),
      kind: 'attention.requested',
      actor: sourceActor,
      semanticSession: sessionRef,
      participants: [sourceActor, target],
      content: {
        kind: effectKind(input.effect) === 'request_observer_review' ? 'markdown' : 'text',
        body: buildInstructionBody({ kind: effectKind(input.effect), reason, payload }),
      },
      links: { taskId: input.taskId },
      meta: buildMeta({ effect: input.effect, role, payload }),
    },
    wake: {
      sessionRef,
      reason,
      dedupeKey: effectIdempotencyKey(input.effect),
    },
  })
}

async function failEffect(input: {
  wrkf: AcpWrkfWorkflowPort
  effect: WrkfEffect
  leaseToken: string
  reason: string
  retryable: boolean
  failed: WrkfEffectReconcileResult['failed']
}): Promise<void> {
  await input.wrkf.effect.fail({
    effectId: effectId(input.effect),
    leaseToken: input.leaseToken,
    retryable: input.retryable,
    reason: input.reason,
  })
  input.failed.push({
    effectId: effectId(input.effect),
    kind: effectKind(input.effect),
    reason: input.reason,
    retryable: input.retryable,
  })
}

async function deliverClaimedEffect(input: {
  deps: WrkfEffectReconcileDeps
  context: TaskContext
  effect: WrkfEffect
  leaseToken: string
  delivered: WrkfEffectReconcileResult['delivered']
  failed: WrkfEffectReconcileResult['failed']
}): Promise<void> {
  try {
    buildWakeCommand({
      coordStore: input.deps.coordStore,
      taskId: input.deps.taskId,
      context: input.context,
      effect: input.effect,
    })
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    await failEffect({
      wrkf: input.deps.wrkf,
      effect: input.effect,
      leaseToken: input.leaseToken,
      reason: reason === UNSUPPORTED_EFFECT_KIND ? UNSUPPORTED_EFFECT_KIND : reason,
      retryable: reason !== UNSUPPORTED_EFFECT_KIND,
      failed: input.failed,
    })
    return
  }

  await input.deps.wrkf.effect.ack({
    effectId: effectId(input.effect),
    leaseToken: input.leaseToken,
  })
  input.delivered.push({ effectId: effectId(input.effect), kind: effectKind(input.effect) })
}

export async function reconcileWrkfEffects(
  deps: WrkfEffectReconcileDeps
): Promise<WrkfEffectReconcileResult> {
  const context = await resolveTaskContext(deps)
  const result: WrkfEffectReconcileResult = { scanned: 0, delivered: [], failed: [] }

  for (const kind of SUPPORTED_EFFECT_KINDS) {
    const claim = parseClaimResponse(
      await deps.wrkf.effect.claim({
        adapter: 'acp',
        kind,
        task: deps.taskId,
        limit: deps.limit ?? DEFAULT_CLAIM_LIMIT,
        leaseMs: deps.leaseMs ?? DEFAULT_LEASE_MS,
      })
    )

    result.scanned += claim.effects.length
    if (claim.effects.length === 0) {
      continue
    }

    for (const effect of claim.effects) {
      await deliverClaimedEffect({
        deps,
        context,
        effect: { ...effect, kind: effect.kind ?? kind },
        leaseToken: claim.leaseToken,
        delivered: result.delivered,
        failed: result.failed,
      })
    }
  }

  return result
}
