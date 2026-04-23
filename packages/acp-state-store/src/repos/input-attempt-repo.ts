import { randomUUID } from 'node:crypto'

import type { Actor } from 'acp-core'
import type { SessionRef } from 'agent-scope'

import {
  InputAttemptConflictError,
  type InputAttemptCreateResult,
  type StoredInputAttempt,
} from '../types.js'
import type { RepoContext } from './shared.js'
import { parseJsonRecord } from './shared.js'

type CreateInputAttemptInput = {
  sessionRef: SessionRef
  taskId?: string | undefined
  idempotencyKey?: string | undefined
  content: string
  actor?: Actor | undefined
  metadata?: Readonly<Record<string, unknown>> | undefined
  runStore: {
    createRun(input: {
      sessionRef: SessionRef
      taskId?: string | undefined
      actor?: Actor | undefined
      metadata?: Readonly<Record<string, unknown>> | undefined
    }): { runId: string }
  }
}

type InputAttemptRow = {
  input_attempt_id: string
  run_id: string
  scope_ref: string
  lane_ref: string
  task_id: string | null
  idempotency_key: string | null
  fingerprint: string
  content: string
  actor_kind: Actor['kind']
  actor_id: string
  actor_display_name: string | null
  metadata_json: string | null
  created_at: string
}

type StoredAttemptRecord = {
  inputAttempt: StoredInputAttempt
  runId: string
  fingerprint: string
}

type TableInfoRow = {
  name: string
}

function normalizeActorInput(actor: Actor | { agentId: string } | undefined): Actor {
  if (actor === undefined) {
    return { kind: 'system', id: 'acp-local' }
  }

  if ('kind' in actor) {
    return actor
  }

  return { kind: 'agent', id: actor.agentId }
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value)
  }

  if (Array.isArray(value)) {
    return `[${value.map((entry) => stableStringify(entry)).join(',')}]`
  }

  const entries = Object.entries(value as Record<string, unknown>).sort(([left], [right]) =>
    left.localeCompare(right)
  )
  return `{${entries
    .map(([key, entryValue]) => `${JSON.stringify(key)}:${stableStringify(entryValue)}`)
    .join(',')}}`
}

function mapInputAttemptRow(row: InputAttemptRow): StoredAttemptRecord {
  return {
    inputAttempt: {
      inputAttemptId: row.input_attempt_id,
      scopeRef: row.scope_ref,
      laneRef: row.lane_ref,
      ...(row.task_id !== null ? { taskId: row.task_id } : {}),
      ...(row.idempotency_key !== null ? { idempotencyKey: row.idempotency_key } : {}),
      actor: {
        kind: row.actor_kind,
        id: row.actor_id,
        ...(row.actor_display_name !== null ? { displayName: row.actor_display_name } : {}),
      },
      createdAt: row.created_at,
      ...(parseJsonRecord(row.metadata_json) !== undefined
        ? { metadata: parseJsonRecord(row.metadata_json) }
        : {}),
    },
    runId: row.run_id,
    fingerprint: row.fingerprint,
  }
}

export class InputAttemptRepo {
  private readonly hasLegacyActorAgentIdColumn: boolean

  constructor(private readonly context: RepoContext) {
    this.hasLegacyActorAgentIdColumn = (
      this.context.sqlite.prepare('PRAGMA table_info(input_attempts)').all() as TableInfoRow[]
    ).some((row) => row.name === 'actor_agent_id')
  }

  createAttempt(input: CreateInputAttemptInput): InputAttemptCreateResult {
    return this.context.sqlite.transaction(() => {
      const actor = normalizeActorInput(input.actor as Actor | { agentId: string } | undefined)
      const fingerprint = stableStringify({
        sessionRef: input.sessionRef,
        taskId: input.taskId,
        content: input.content,
        actor,
        metadata: input.metadata,
      })

      if (input.idempotencyKey !== undefined) {
        const existing = this.getByIdempotencyKey(input.sessionRef, input.idempotencyKey)
        if (existing !== undefined) {
          if (existing.fingerprint !== fingerprint) {
            throw new InputAttemptConflictError(input.idempotencyKey)
          }

          return {
            inputAttempt: existing.inputAttempt,
            runId: existing.runId,
            created: false,
          }
        }
      }

      const run = input.runStore.createRun({
        sessionRef: input.sessionRef,
        ...(input.taskId !== undefined ? { taskId: input.taskId } : {}),
        actor,
        metadata: {
          content: input.content,
          ...(input.metadata !== undefined ? { meta: input.metadata } : {}),
        },
      })

      const inputAttempt: StoredInputAttempt = {
        inputAttemptId: `ia_${randomUUID().replace(/-/g, '').slice(0, 12)}`,
        scopeRef: input.sessionRef.scopeRef,
        laneRef: input.sessionRef.laneRef,
        actor,
        createdAt: new Date().toISOString(),
        ...(input.taskId !== undefined ? { taskId: input.taskId } : {}),
        ...(input.idempotencyKey !== undefined ? { idempotencyKey: input.idempotencyKey } : {}),
        ...(input.metadata !== undefined ? { metadata: input.metadata } : {}),
      }

      if (this.hasLegacyActorAgentIdColumn) {
        this.context.sqlite
          .prepare(
            `INSERT INTO input_attempts (
               input_attempt_id,
               run_id,
               scope_ref,
               lane_ref,
               task_id,
               idempotency_key,
               fingerprint,
               content,
               actor_kind,
               actor_id,
               actor_display_name,
               actor_agent_id,
               metadata_json,
               created_at
             ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
          )
          .run(
            inputAttempt.inputAttemptId,
            run.runId,
            inputAttempt.scopeRef,
            inputAttempt.laneRef,
            inputAttempt.taskId ?? null,
            inputAttempt.idempotencyKey ?? null,
            fingerprint,
            input.content,
            actor.kind,
            actor.id,
            actor.displayName ?? null,
            actor.id,
            inputAttempt.metadata === undefined ? null : JSON.stringify(inputAttempt.metadata),
            inputAttempt.createdAt
          )
      } else {
        this.context.sqlite
          .prepare(
            `INSERT INTO input_attempts (
               input_attempt_id,
               run_id,
               scope_ref,
               lane_ref,
               task_id,
               idempotency_key,
               fingerprint,
               content,
               actor_kind,
               actor_id,
               actor_display_name,
               metadata_json,
               created_at
             ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
          )
          .run(
            inputAttempt.inputAttemptId,
            run.runId,
            inputAttempt.scopeRef,
            inputAttempt.laneRef,
            inputAttempt.taskId ?? null,
            inputAttempt.idempotencyKey ?? null,
            fingerprint,
            input.content,
            actor.kind,
            actor.id,
            actor.displayName ?? null,
            inputAttempt.metadata === undefined ? null : JSON.stringify(inputAttempt.metadata),
            inputAttempt.createdAt
          )
      }

      return {
        inputAttempt,
        runId: run.runId,
        created: true,
      }
    })()
  }

  private getByIdempotencyKey(
    sessionRef: SessionRef,
    idempotencyKey: string
  ): StoredAttemptRecord | undefined {
    const row = this.context.sqlite
      .prepare(
        `SELECT input_attempt_id,
                run_id,
                scope_ref,
                lane_ref,
                task_id,
                idempotency_key,
                fingerprint,
                content,
                actor_kind,
                actor_id,
                actor_display_name,
                metadata_json,
                created_at
           FROM input_attempts
          WHERE scope_ref = ?
            AND lane_ref = ?
            AND idempotency_key = ?`
      )
      .get(sessionRef.scopeRef, sessionRef.laneRef, idempotencyKey) as InputAttemptRow | undefined

    return row === undefined ? undefined : mapInputAttemptRow(row)
  }
}
