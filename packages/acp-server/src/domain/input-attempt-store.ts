import { randomUUID } from 'node:crypto'

import type { Actor, InputAttempt } from 'acp-core'
import type { SessionRef } from 'agent-scope'

import { conflict } from '../http.js'
import type { RunStore } from './run-store.js'

type StoredAttemptRecord = {
  fingerprint: string
  inputAttempt: InputAttempt
  runId: string
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

export interface InputAttemptStore {
  createAttempt(input: {
    sessionRef: SessionRef
    taskId?: string | undefined
    idempotencyKey?: string | undefined
    content: string
    actor?: Actor | undefined
    metadata?: Readonly<Record<string, unknown>> | undefined
    runStore: RunStore
  }): { inputAttempt: InputAttempt; runId: string; created: boolean }
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

export class InMemoryInputAttemptStore implements InputAttemptStore {
  private readonly attemptsByIdempotencyKey = new Map<string, StoredAttemptRecord>()

  private getAttemptKey(sessionRef: SessionRef, idempotencyKey: string): string {
    return `${sessionRef.scopeRef}\u0000${sessionRef.laneRef}\u0000${idempotencyKey}`
  }

  createAttempt(input: {
    sessionRef: SessionRef
    taskId?: string | undefined
    idempotencyKey?: string | undefined
    content: string
    actor?: Actor | undefined
    metadata?: Readonly<Record<string, unknown>> | undefined
    runStore: RunStore
  }): { inputAttempt: InputAttempt; runId: string; created: boolean } {
    const actor = normalizeActorInput(input.actor as Actor | { agentId: string } | undefined)
    const fingerprint = stableStringify({
      sessionRef: input.sessionRef,
      taskId: input.taskId,
      content: input.content,
      actor,
      metadata: input.metadata,
    })

    if (input.idempotencyKey !== undefined) {
      const existing = this.attemptsByIdempotencyKey.get(
        this.getAttemptKey(input.sessionRef, input.idempotencyKey)
      )
      if (existing !== undefined) {
        if (existing.fingerprint !== fingerprint) {
          conflict(
            `different request body already exists for idempotencyKey ${input.idempotencyKey}`
          )
        }

        return {
          inputAttempt: structuredClone(existing.inputAttempt),
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
    const inputAttempt: InputAttempt = {
      inputAttemptId: `ia_${randomUUID().replace(/-/g, '').slice(0, 12)}`,
      scopeRef: input.sessionRef.scopeRef,
      laneRef: input.sessionRef.laneRef,
      actor: structuredClone(actor),
      createdAt: new Date().toISOString(),
      ...(input.taskId !== undefined ? { taskId: input.taskId } : {}),
      ...(input.idempotencyKey !== undefined ? { idempotencyKey: input.idempotencyKey } : {}),
      ...(input.metadata !== undefined ? { metadata: input.metadata } : {}),
    }

    if (input.idempotencyKey !== undefined) {
      this.attemptsByIdempotencyKey.set(
        this.getAttemptKey(input.sessionRef, input.idempotencyKey),
        {
          fingerprint,
          inputAttempt,
          runId: run.runId,
        }
      )
    }

    return {
      inputAttempt: structuredClone(inputAttempt),
      runId: run.runId,
      created: true,
    }
  }
}
