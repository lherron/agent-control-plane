import type { LoggedTransitionRecord, TransitionLogStore } from 'acp-core'

import { parseJsonValue } from '../json.js'
import {
  type TransitionRow,
  mapTransitionRow,
  mapTransitionToWriteRecord,
} from '../mapping/transition-row.js'
import type { RepoContext } from './shared.js'
import { requireTaskLookup } from './shared.js'

type EvidenceLookupRow = {
  uuid: string
  kind: string
  meta: string | null
}

function findTransitionEvidenceItemUuids(
  context: RepoContext,
  taskUuid: string,
  transition: LoggedTransitionRecord
): string[] {
  const rows = context.sqlite
    .prepare(
      `SELECT uuid, kind, meta
         FROM evidence_items
        WHERE task_uuid = ?
        ORDER BY produced_at ASC, id ASC`
    )
    .all(taskUuid) as EvidenceLookupRow[]

  const cited = new Set<string>()
  const directKinds = new Set(transition.evidenceKinds)
  const waivedKinds = new Set(transition.waivedEvidenceKinds)

  for (const row of rows) {
    if (directKinds.has(row.kind)) {
      cited.add(row.uuid)
      continue
    }

    if (!waivedKinds.size || row.kind !== 'waiver') {
      continue
    }

    const details = parseJsonValue(row.meta)
    const waiverKind =
      details !== undefined && typeof details === 'object' && details !== null
        ? (details as Record<string, unknown>)['waiverKind']
        : undefined
    if (typeof waiverKind === 'string' && waivedKinds.has(waiverKind)) {
      cited.add(row.uuid)
    }
  }

  return [...cited]
}

export class TransitionLogRepo implements TransitionLogStore {
  constructor(private readonly context: RepoContext) {}

  listTransitions(taskId: string): readonly LoggedTransitionRecord[] {
    return this.context.sqlite.transaction((id: string) => {
      const task = this.context.sqlite.prepare('SELECT uuid FROM tasks WHERE id = ?').get(id) as
        | { uuid: string }
        | undefined

      if (task === undefined) {
        return []
      }

      const rows = this.context.sqlite
        .prepare(
          `SELECT tt.id,
                  tt.from_phase,
                  tt.to_phase,
                  tt.from_lifecycle_state,
                  tt.to_lifecycle_state,
                  a.slug AS actor_slug,
                  tt.actor_role,
                  tt.transitioned_at,
                  tt.meta
             FROM task_transitions AS tt
             JOIN actors AS a ON a.uuid = tt.actor_uuid
            WHERE tt.task_uuid = ?
            ORDER BY tt.transitioned_at ASC, tt.id ASC`
        )
        .all(task.uuid) as TransitionRow[]

      return rows.map((row) => mapTransitionRow(id, row))
    })(taskId)
  }

  appendTransition(taskId: string, transition: LoggedTransitionRecord): void {
    this.context.sqlite.transaction((id: string, recordInput: LoggedTransitionRecord) => {
      if (recordInput.taskId !== id) {
        throw new Error(
          `Transition taskId ${recordInput.taskId} does not match appendTransition target ${id}`
        )
      }

      const task = requireTaskLookup(this.context.sqlite, id)
      const actorUuid = this.context.actorResolver.resolveActorUuid({
        agentId: recordInput.actor.agentId,
      })
      const evidenceItemUuids = findTransitionEvidenceItemUuids(
        this.context,
        task.uuid,
        recordInput
      )
      const record = mapTransitionToWriteRecord({
        transition: recordInput,
        actorUuid,
        evidenceItemUuids,
      })

      this.context.sqlite
        .prepare(
          `INSERT INTO task_transitions (
             id,
             task_uuid,
             from_phase,
             to_phase,
             from_lifecycle_state,
             to_lifecycle_state,
             actor_uuid,
             actor_role,
             evidence_item_uuids,
             transitioned_at,
             meta
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          record.id,
          task.uuid,
          record.fromPhase,
          record.toPhase,
          record.fromLifecycleState,
          record.toLifecycleState,
          record.actorUuid,
          record.actorRole,
          record.evidenceItemUuids,
          record.transitionedAt,
          record.meta
        )
    })(taskId, transition)
  }
}
