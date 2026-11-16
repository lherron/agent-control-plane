import type { EffectIntent } from 'acp-core'

export type EffectRow = {
  effect_id: string
  task_id: string
  source_event_id: string
  kind: string
  payload_json: string
  idempotency_key: string
  state: EffectIntent['state']
  created_at: string
  updated_at: string
}

export function mapEffect(row: EffectRow): EffectIntent {
  return {
    effectId: row.effect_id,
    taskId: row.task_id,
    sourceEventId: row.source_event_id,
    kind: row.kind,
    payload: JSON.parse(row.payload_json) as Record<string, unknown>,
    idempotencyKey: row.idempotency_key,
    state: row.state,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}
