import type { EvidenceItem, EvidenceStore } from 'acp-core'

import {
  type EvidenceRow,
  mapEvidenceRow,
  mapEvidenceToWriteRecord,
} from '../mapping/evidence-row.js'
import type { RepoContext } from './shared.js'
import { requireTaskLookup } from './shared.js'

export class EvidenceRepo implements EvidenceStore {
  constructor(private readonly context: RepoContext) {}

  listEvidence(taskId: string): readonly EvidenceItem[] {
    return this.context.sqlite.transaction((id: string) => {
      const task = this.context.sqlite.prepare('SELECT uuid FROM tasks WHERE id = ?').get(id) as
        | { uuid: string }
        | undefined

      if (task === undefined) {
        return []
      }

      const rows = this.context.sqlite
        .prepare(
          `SELECT ei.kind,
                  ei.ref,
                  ei.content_hash,
                  a.slug AS actor_slug,
                  ei.produced_by_role,
                  ei.build_id,
                  ei.build_version,
                  ei.build_env,
                  ei.produced_at,
                  ei.meta
             FROM evidence_items AS ei
             JOIN actors AS a ON a.uuid = ei.produced_by_actor_uuid
            WHERE ei.task_uuid = ?
            ORDER BY ei.produced_at ASC, ei.id ASC`
        )
        .all(task.uuid) as EvidenceRow[]

      return rows.map((row) => mapEvidenceRow(row))
    })(taskId)
  }

  appendEvidence(taskId: string, evidence: readonly EvidenceItem[]): void {
    this.context.sqlite.transaction((id: string, items: readonly EvidenceItem[]) => {
      const task = requireTaskLookup(this.context.sqlite, id)
      const insert = this.context.sqlite.prepare(
        `INSERT INTO evidence_items (
           id,
           task_uuid,
           kind,
           ref,
           content_hash,
           produced_by_actor_uuid,
           produced_by_role,
           build_id,
           build_version,
           build_env,
           produced_at,
         meta
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )

      for (const item of items) {
        const defaultActor = this.context.actorResolver.getDefaultActor()
        const actorUuid = this.context.actorResolver.resolveActorUuid({
          agentId: item.producedBy?.agentId ?? defaultActor.agentId,
          ...(item.producedBy?.agentId === undefined && defaultActor.displayName !== undefined
            ? { displayName: defaultActor.displayName }
            : {}),
        })

        const record = mapEvidenceToWriteRecord({
          evidence: item,
          producedByActorUuid: actorUuid,
          defaultTimestamp: new Date().toISOString(),
          defaultRole: 'agent',
        })
        const evidenceId = (
          this.context.sqlite
            .prepare(
              `SELECT printf('EV-%05d', COALESCE(MAX(CAST(substr(id, 4) AS INTEGER)), 0) + 1) AS id
                 FROM evidence_items
                WHERE id GLOB 'EV-[0-9]*'`
            )
            .get() as { id: string }
        ).id

        insert.run(
          evidenceId,
          task.uuid,
          record.kind,
          record.ref,
          record.contentHash,
          record.producedByActorUuid,
          record.producedByRole,
          record.buildId,
          record.buildVersion,
          record.buildEnv,
          record.producedAt,
          record.meta
        )
      }
    })(taskId, evidence)
  }
}
