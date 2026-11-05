import type { AdminStore } from 'acp-admin-store'
import { parseScopeRef } from 'agent-scope'
import { type CoordinationStore, consumeWake, leaseWake } from 'coordination-substrate'
import type { StoreCommitBus } from '../store-commit-bus.js'
import { createStoreScanLoop } from './store-scan-loop.js'

import type { AgentRootResolver, LaunchRoleScopedRun, RuntimeResolver } from '../deps.js'
import type { InputAttemptStore } from '../domain/input-attempt-store.js'
import type { RunStore } from '../domain/run-store.js'
import { resolveLaunchIntent } from '../launch-role-scoped.js'

type WakeRequestRow = {
  wake_id: string
}

export type WakeDispatcherInput = {
  commitBus?: StoreCommitBus | undefined
  coordStore: CoordinationStore
  inputAttemptStore: InputAttemptStore
  runStore: RunStore
  adminStore: AdminStore
  runtimeResolver: NonNullable<RuntimeResolver>
  agentRootResolver?: AgentRootResolver | undefined
  launchRoleScopedRun: NonNullable<LaunchRoleScopedRun>
  admitInput?:
    | ((input: {
        sessionRef: { scopeRef: string; laneRef: string }
        taskId?: string | undefined
        idempotencyKey?: string | undefined
        content: string
        actor: { kind: 'agent'; id: string }
      }) => Promise<{ inputAttemptId: string; runId: string; created: boolean }>)
    | undefined
}

export type WakeDispatcher = {
  start(input: { intervalMs: number }): void | Promise<void>
  stop(): Promise<void>
  runOnce(): Promise<void>
}

function listQueuedWakeIds(coordStore: CoordinationStore): string[] {
  const rows = coordStore.sqlite
    .query<WakeRequestRow, []>(
      `SELECT wake_id FROM wake_requests WHERE state = 'queued' ORDER BY created_at ASC, wake_id ASC`
    )
    .all()

  return rows.map((row) => row.wake_id)
}

export function createWakeDispatcher(input: WakeDispatcherInput): WakeDispatcher {
  const {
    coordStore,
    inputAttemptStore,
    runStore,
    adminStore,
    runtimeResolver,
    agentRootResolver,
    launchRoleScopedRun,
  } = input

  let intervalMs = 2_000
  let nextDelayMs = 60_000

  async function dispatchWake(wakeId: string): Promise<void> {
    const leasedUntil = new Date(Date.now() + 60_000).toISOString()
    const leased = leaseWake(coordStore, { wakeId, leasedUntil })
    if (leased === undefined) {
      return
    }

    const sessionRef = leased.sessionRef
    const parsedScope = parseScopeRef(sessionRef.scopeRef)
    const idempotencyKey = leased.dedupeKey ?? leased.wakeId

    if (input.admitInput !== undefined) {
      const admitted = await input.admitInput({
        sessionRef,
        ...(parsedScope.taskId !== undefined ? { taskId: parsedScope.taskId } : {}),
        idempotencyKey,
        content: leased.reason ?? 'wake dispatch',
        actor: { kind: 'agent', id: parsedScope.agentId },
      })
      if (admitted.created) {
        consumeWake(coordStore, { wakeId: leased.wakeId })
      }
      return
    }

    const result = inputAttemptStore.createAttempt({
      sessionRef,
      ...(parsedScope.taskId !== undefined ? { taskId: parsedScope.taskId } : {}),
      idempotencyKey,
      content: leased.reason ?? 'wake dispatch',
      actor: { kind: 'agent', id: parsedScope.agentId },
      runStore,
    })

    if (!result.created) {
      return
    }
    if (result.runId === undefined) {
      throw new Error(
        `wake input attempt did not create a run: ${result.inputAttempt.inputAttemptId}`
      )
    }

    try {
      const intent = await resolveLaunchIntent(
        { runtimeResolver, agentRootResolver, adminStore },
        sessionRef
      )

      await launchRoleScopedRun({
        sessionRef,
        intent,
        acpRunId: result.runId,
        inputAttemptId: result.inputAttempt.inputAttemptId,
        runStore,
      })

      consumeWake(coordStore, { wakeId: leased.wakeId })
    } catch (error) {
      const errorCode =
        typeof (error as Record<string, unknown> | undefined)?.['code'] === 'string'
          ? ((error as Record<string, unknown>)['code'] as string)
          : 'launch_failed'
      const errorMessage = error instanceof Error ? error.message : String(error)

      runStore.updateRun(result.runId, { errorCode, errorMessage })
    }
  }

  async function runOnce(): Promise<void> {
    const wakeIds = listQueuedWakeIds(coordStore)
    nextDelayMs = wakeIds.length > 0 ? intervalMs : 60_000

    for (const wakeId of wakeIds) {
      await dispatchWake(wakeId)
    }
  }

  const loop = createStoreScanLoop({
    name: 'wake-dispatcher',
    bus: input.commitBus,
    topics: ['coordination'],
    scan: runOnce,
    nextDelayMs: () => (input.commitBus === undefined ? intervalMs : nextDelayMs),
  })
  function start(opts: { intervalMs: number }): void {
    intervalMs = opts.intervalMs
    loop.start()
  }
  const stop = loop.stop

  return { start, stop, runOnce }
}
