import type { AdminStore } from 'acp-admin-store'
import { parseScopeRef } from 'agent-scope'
import { type CoordinationStore, consumeWake, leaseWake } from 'coordination-substrate'

import type { AgentRootResolver, LaunchRoleScopedRun, RuntimeResolver } from '../deps.js'
import type { InputAttemptStore } from '../domain/input-attempt-store.js'
import type { RunStore } from '../domain/run-store.js'
import { resolveLaunchIntent } from '../launch-role-scoped.js'

type WakeRequestRow = {
  wake_id: string
}

export type WakeDispatcherInput = {
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

  let running = false
  let inflight: Promise<void> | undefined
  let _stopResolve: (() => void) | undefined
  let timer: ReturnType<typeof setTimeout> | undefined

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

    for (const wakeId of wakeIds) {
      await dispatchWake(wakeId)
    }
  }

  function scheduleNext(intervalMs: number): void {
    if (!running) {
      return
    }

    timer = setTimeout(() => {
      if (!running) {
        return
      }

      const pass = runOnce()
      inflight = pass
      void pass
        .catch(() => {})
        .then(() => {
          inflight = undefined
          scheduleNext(intervalMs)
        })
    }, intervalMs)
  }

  function start(opts: { intervalMs: number }): void {
    running = true

    const pass = runOnce()
    inflight = pass
    void pass
      .catch(() => {})
      .then(() => {
        inflight = undefined
        scheduleNext(opts.intervalMs)
      })
  }

  async function stop(): Promise<void> {
    running = false

    if (timer !== undefined) {
      clearTimeout(timer)
      timer = undefined
    }

    if (inflight !== undefined) {
      await inflight
    }
  }

  return { start, stop, runOnce }
}
