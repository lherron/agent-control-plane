import { createHash } from 'node:crypto'

import { type ActorRef, type EffectIntent, type WorkflowKernelSnapshot, stableJson } from 'acp-core'

import type { RepoContext } from './shared.js'
import { type EffectRow, mapEffect } from './workflow-effect-row.js'
import { loadWorkflowSnapshot } from './workflow-snapshot-reader.js'
import { saveWorkflowSnapshot } from './workflow-snapshot-writer.js'

type EffectSourceRow = {
  event_id: string
  workflow_id: string
  workflow_version: number
  workflow_hash: string
  actor_json: string
  observed_task_version: number
  next_task_version: number | null
  event_hash: string
}

function hashValue(value: unknown): string {
  return `sha256:${createHash('sha256').update(stableJson(value)).digest('hex')}`
}

export class WorkflowRuntimeRepo {
  constructor(private readonly context: RepoContext) {}

  private appendEffectLifecycleEvent(
    effect: EffectRow,
    input: {
      type: string
      deliveryResult?: string | undefined
      errorCode?: string | undefined
      errorMessage?: string | undefined
    }
  ): void {
    const source = this.context.sqlite
      .prepare(
        `SELECT event_id, workflow_seq, schema_version, task_id, workflow_id,
                workflow_version, workflow_hash, actor_json, observed_task_version,
                next_task_version, event_hash
           FROM workflow_events
          WHERE event_id = ?`
      )
      .get(effect.source_event_id) as EffectSourceRow | undefined

    if (source === undefined) {
      throw new Error(`workflow effect source event missing: ${effect.source_event_id}`)
    }

    const workflowSeq =
      (
        this.context.sqlite
          .prepare(
            'SELECT max(workflow_seq) AS workflow_seq FROM workflow_events WHERE task_id = ?'
          )
          .get(effect.task_id) as { workflow_seq: number | null } | undefined
      )?.workflow_seq ?? 0
    const eventId = `wevt_${effect.effect_id}_${input.type.replaceAll('.', '_')}`
    const payload = {
      effectId: effect.effect_id,
      effectKind: effect.kind,
      ...(input.deliveryResult !== undefined ? { deliveryResult: input.deliveryResult } : {}),
      ...(input.errorCode !== undefined ? { errorCode: input.errorCode } : {}),
      ...(input.errorMessage !== undefined ? { errorMessage: input.errorMessage } : {}),
      sourceWorkflowEventId: effect.source_event_id,
    }
    const eventWithoutHash = {
      eventId,
      workflowSeq: workflowSeq + 1,
      schemaVersion: 1,
      taskId: effect.task_id,
      workflow: {
        id: source.workflow_id,
        version: source.workflow_version,
        hash: source.workflow_hash,
      },
      type: input.type,
      commandType: input.type,
      commandHash: hashValue({ type: input.type, effectId: effect.effect_id, payload }),
      causationId: source.event_id,
      actor: JSON.parse(source.actor_json) as ActorRef,
      observedTaskVersion: source.next_task_version ?? source.observed_task_version,
      idempotencyKey: `${effect.idempotency_key}:${input.type}`,
      result: 'recorded' as const,
      payload,
      prevHash: source.event_hash,
      createdAt: new Date().toISOString(),
    }
    this.context.sqlite
      .prepare(
        `INSERT OR IGNORE INTO workflow_events (
           event_id, workflow_seq, schema_version, task_id, workflow_id, workflow_version,
           workflow_hash, type, command_type, command_hash, causation_id, correlation_id,
           actor_json, role, authority, run_id, supervisor_run_id, participant_run_id,
           observed_task_version, next_task_version, context_hash, idempotency_key, result,
           rejection_code, payload_json, event_hash, prev_hash, created_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        eventWithoutHash.eventId,
        eventWithoutHash.workflowSeq,
        eventWithoutHash.schemaVersion,
        eventWithoutHash.taskId,
        eventWithoutHash.workflow.id,
        eventWithoutHash.workflow.version,
        eventWithoutHash.workflow.hash,
        eventWithoutHash.type,
        eventWithoutHash.commandType,
        eventWithoutHash.commandHash,
        eventWithoutHash.causationId,
        null,
        JSON.stringify(eventWithoutHash.actor),
        null,
        null,
        null,
        null,
        null,
        eventWithoutHash.observedTaskVersion,
        null,
        null,
        eventWithoutHash.idempotencyKey,
        eventWithoutHash.result,
        null,
        JSON.stringify(eventWithoutHash.payload),
        hashValue(eventWithoutHash),
        eventWithoutHash.prevHash,
        eventWithoutHash.createdAt
      )
  }

  listPendingEffectIntents(limit = 100): EffectIntent[] {
    const rows = this.context.sqlite
      .prepare(
        `SELECT effect_id, task_id, source_event_id, kind, payload_json, idempotency_key,
                state, created_at, updated_at
           FROM workflow_effect_intents
          WHERE state = 'pending'
       ORDER BY created_at, effect_id
          LIMIT ?`
      )
      .all(limit) as EffectRow[]

    return rows.map(mapEffect)
  }

  leaseEffectIntent(effectId: string): EffectIntent | undefined {
    return this.context.sqlite.transaction((id: string) => {
      const existing = this.context.sqlite
        .prepare(
          `SELECT effect_id, task_id, source_event_id, kind, payload_json, idempotency_key,
                  state, created_at, updated_at
             FROM workflow_effect_intents
            WHERE effect_id = ?`
        )
        .get(id) as EffectRow | null

      if (existing === null || existing.state !== 'pending') {
        return undefined
      }

      const updatedAt = new Date().toISOString()
      this.context.sqlite
        .prepare('UPDATE workflow_effect_intents SET state = ?, updated_at = ? WHERE effect_id = ?')
        .run('leased', updatedAt, id)

      this.appendEffectLifecycleEvent(existing, { type: 'effect.intent.leased' })

      return { ...mapEffect(existing), state: 'leased', updatedAt } satisfies EffectIntent
    })(effectId)
  }

  /**
   * Transition an effect intent to a terminal state and append the matching
   * lifecycle event. No-op (matching the prior per-method guard) when the
   * effect is absent or already in the target state.
   */
  private transitionEffectIntent(
    effectId: string,
    target: EffectRow['state'],
    lifecycleEvent: (effect: EffectRow) => {
      type: string
      deliveryResult?: string | undefined
      errorCode?: string | undefined
      errorMessage?: string | undefined
    }
  ): void {
    const existing = this.context.sqlite
      .prepare(
        `SELECT effect_id, task_id, source_event_id, kind, payload_json, idempotency_key,
                state, created_at, updated_at
           FROM workflow_effect_intents
          WHERE effect_id = ?`
      )
      .get(effectId) as EffectRow | undefined
    if (existing === undefined || existing.state === target) {
      return
    }
    this.context.sqlite
      .prepare('UPDATE workflow_effect_intents SET state = ?, updated_at = ? WHERE effect_id = ?')
      .run(target, new Date().toISOString(), effectId)
    this.appendEffectLifecycleEvent(existing, lifecycleEvent(existing))
  }

  markEffectIntentDelivered(effectId: string): void {
    this.transitionEffectIntent(effectId, 'delivered', () => ({
      type: 'effect.intent.delivered',
      deliveryResult: 'delivered',
    }))
  }

  markEffectIntentFailed(effectId: string): void {
    this.transitionEffectIntent(effectId, 'failed', () => ({
      type: 'effect.intent.failed',
      deliveryResult: 'failed',
    }))
  }

  markEffectIntentUnsupported(effectId: string): void {
    this.transitionEffectIntent(effectId, 'unsupported', (existing) => ({
      type: 'effect.intent.unsupported',
      deliveryResult: 'unsupported',
      errorCode: 'unsupported_effect',
      errorMessage: `Unsupported workflow effect kind: ${existing.kind}`,
    }))
  }

  loadSnapshot(): WorkflowKernelSnapshot {
    return loadWorkflowSnapshot(this.context.sqlite)
  }

  saveSnapshot(snapshot: WorkflowKernelSnapshot): void {
    saveWorkflowSnapshot(this.context.sqlite, snapshot)
  }
}
