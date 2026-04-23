import type { LoggedTransitionRecord } from 'acp-core'

import { parseJsonRecord, stableStringify } from '../json.js'

export type TransitionRow = {
  id: string
  from_phase: string | null
  to_phase: string
  from_lifecycle_state: string | null
  to_lifecycle_state: string | null
  actor_slug: string
  actor_role: string
  transitioned_at: string
  meta: string | null
}

export type TransitionWriteRecord = {
  id: string
  fromPhase: string | null
  toPhase: string
  fromLifecycleState: string | null
  toLifecycleState: string | null
  actorUuid: string
  actorRole: string
  evidenceItemUuids: string | null
  transitionedAt: string
  meta: string
}

type TransitionMetaPayload = {
  requiredEvidenceKinds: readonly string[]
  evidenceKinds: readonly string[]
  waivedEvidenceKinds: readonly string[]
  expectedVersion: number
  nextVersion: number
  scopeRef?: string | undefined
}

function readTransitionMeta(meta: string | null): TransitionMetaPayload {
  const parsed = parseJsonRecord(meta)
  if (parsed === undefined) {
    return {
      requiredEvidenceKinds: [],
      evidenceKinds: [],
      waivedEvidenceKinds: [],
      expectedVersion: 0,
      nextVersion: 0,
    }
  }

  const requiredEvidenceKinds = Array.isArray(parsed['requiredEvidenceKinds'])
    ? parsed['requiredEvidenceKinds'].filter((value): value is string => typeof value === 'string')
    : []
  const evidenceKinds = Array.isArray(parsed['evidenceKinds'])
    ? parsed['evidenceKinds'].filter((value): value is string => typeof value === 'string')
    : []
  const waivedEvidenceKinds = Array.isArray(parsed['waivedEvidenceKinds'])
    ? parsed['waivedEvidenceKinds'].filter((value): value is string => typeof value === 'string')
    : []

  return {
    requiredEvidenceKinds,
    evidenceKinds,
    waivedEvidenceKinds,
    expectedVersion: typeof parsed['expectedVersion'] === 'number' ? parsed['expectedVersion'] : 0,
    nextVersion: typeof parsed['nextVersion'] === 'number' ? parsed['nextVersion'] : 0,
    ...(typeof parsed['scopeRef'] === 'string' ? { scopeRef: parsed['scopeRef'] } : {}),
  }
}

export function mapTransitionRow(taskId: string, row: TransitionRow): LoggedTransitionRecord {
  const meta = readTransitionMeta(row.meta)

  return {
    taskId,
    transitionEventId: row.id,
    timestamp: row.transitioned_at,
    from: {
      lifecycleState: row.from_lifecycle_state ?? 'open',
      phase: row.from_phase,
    },
    to: {
      lifecycleState: row.to_lifecycle_state ?? 'open',
      phase: row.to_phase,
    },
    actor: {
      agentId: row.actor_slug,
      role: row.actor_role,
      ...(meta.scopeRef !== undefined ? { scopeRef: meta.scopeRef } : {}),
    },
    requiredEvidenceKinds: meta.requiredEvidenceKinds,
    evidenceKinds: meta.evidenceKinds,
    waivedEvidenceKinds: meta.waivedEvidenceKinds,
    expectedVersion: meta.expectedVersion,
    nextVersion: meta.nextVersion,
  }
}

export function mapTransitionToWriteRecord(input: {
  transition: LoggedTransitionRecord
  actorUuid: string
  evidenceItemUuids: readonly string[]
}): TransitionWriteRecord {
  const meta: Record<string, unknown> = {
    requiredEvidenceKinds: [...input.transition.requiredEvidenceKinds],
    evidenceKinds: [...input.transition.evidenceKinds],
    waivedEvidenceKinds: [...input.transition.waivedEvidenceKinds],
    expectedVersion: input.transition.expectedVersion,
    nextVersion: input.transition.nextVersion,
  }

  if (input.transition.actor.scopeRef !== undefined) {
    meta['scopeRef'] = input.transition.actor.scopeRef
  }

  return {
    id: input.transition.transitionEventId,
    fromPhase: input.transition.from.phase === '' ? null : input.transition.from.phase,
    toPhase: input.transition.to.phase ?? '',
    fromLifecycleState:
      input.transition.from.lifecycleState === '' ? null : input.transition.from.lifecycleState,
    toLifecycleState:
      input.transition.to.lifecycleState === '' ? null : input.transition.to.lifecycleState,
    actorUuid: input.actorUuid,
    actorRole: input.transition.actor.role,
    evidenceItemUuids:
      input.evidenceItemUuids.length > 0 ? stableStringify(input.evidenceItemUuids) : null,
    transitionedAt: input.transition.timestamp,
    meta: stableStringify(meta),
  }
}
