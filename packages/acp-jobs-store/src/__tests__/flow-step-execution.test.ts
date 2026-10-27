/**
 * T-04943 Phase B — RED tests: native side-effect step execution.
 *
 * Covers daedalus required tests #3 (wrkq-task idempotency), #5 (pulpit),
 * #6 (agent-dispatch), and the terminal-step replay safety guard.
 *
 * Asserts:
 *   - wrkq-task step: calls wrkqTaskPort.createOrFind; persists { taskId, projectId, taskPath, created }
 *   - pulpit-message step: calls sendPulpitMessage with exact idempotency key; persists result
 *   - agent-dispatch step: calls dispatchAgentInput with deterministic key + health incident metadata
 *   - Terminal step replay: a succeeded step row is NOT re-executed on scheduler retry
 *   - Idempotency key formats match daedalus exact specification
 *
 * All tests are RED until Phase B execution ships — executeNativeSideEffectStep
 * is a stub that throws "not implemented".
 */

import { describe, expect, test } from 'bun:test'

import { createInMemoryJobsStore } from '../index.js'
import {
  type DispatchAgentInput,
  type NativeStepExecutorDeps,
  type SendPulpitMessage,
  type WrkqTaskPort,
  type WrkqTaskStepResult,
  executeNativeSideEffectStep,
} from '../native-step-executor.js'

// ─── helpers ─────────────────────────────────────────────────────────────────

function makeJobRun(store: ReturnType<typeof createInMemoryJobsStore>, jobId?: string) {
  const { job } = store.createJob({
    jobId,
    agentId: 'acp-health',
    projectId: 'agent-control-plane',
    scopeRef: 'agent:fettle:project:agent-control-plane:task:primary',
    laneRef: 'main',
    schedule: { cron: '0 0 * * *' },
    input: { content: 'health incident dispatch' },
    flow: {
      sequence: [
        {
          id: 'create_task',
          kind: 'wrkq-task',
          title: 'ACP health: dispatch timeout',
          container: 'agent-control-plane/inbox',
        },
        {
          id: 'notify_pulpit',
          kind: 'pulpit-message',
          content: 'Incident task created.',
          binding: 'discord:primary',
        },
        {
          id: 'dispatch_fettle',
          kind: 'agent-dispatch',
          scopeRef: 'agent:fettle:project:agent-control-plane:task:T-05001',
          laneRef: 'main',
        },
      ],
    },
    disabled: false,
    createdAt: '2026-06-19T00:00:00.000Z',
  })

  const { jobRun } = store.appendJobRun({
    jobId: job.jobId,
    triggeredAt: '2026-06-19T10:00:00.000Z',
    triggeredBy: 'event',
    status: 'running',
    actor: { kind: 'system', id: 'acp-scheduler' },
    actorStamp: 'system:acp-scheduler',
  })

  store.jobStepRuns.insertMany(jobRun.jobRunId, 'sequence', [
    { stepId: 'create_task', status: 'pending', attempt: 1 },
    { stepId: 'notify_pulpit', status: 'pending', attempt: 1 },
    { stepId: 'dispatch_fettle', status: 'pending', attempt: 1 },
  ])

  return { job, jobRun }
}

function makeWrkqTaskPort(
  override?: Partial<WrkqTaskStepResult> & { createCount?: { count: number } }
): WrkqTaskPort {
  const tasks = new Map<string, WrkqTaskStepResult>()
  const counter = override?.createCount ?? { count: 0 }
  return {
    async createOrFind(input) {
      const existing = tasks.get(input.key)
      if (existing !== undefined) {
        return { ...existing, created: false }
      }
      counter.count += 1
      const result: WrkqTaskStepResult = {
        taskId: override?.taskId ?? 'T-05001',
        projectId: input.projectId,
        taskPath: input.path,
        created: true,
        ...override,
      }
      tasks.set(input.key, result)
      return result
    },
  }
}

function makeSendPulpitMessage(): {
  port: SendPulpitMessage
  calls: Array<{ idempotencyKey: string; text: string; bindingId?: string }>
} {
  const calls: Array<{ idempotencyKey: string; text: string; bindingId?: string }> = []
  const port: SendPulpitMessage = async (input) => {
    calls.push(input)
    return {
      deliveryRequestId: `dr_${calls.length.toString().padStart(6, '0')}`,
      bindingId: input.bindingId ?? 'binding_discord_primary',
    }
  }
  return { port, calls }
}

function makeDispatchAgentInput(): {
  port: DispatchAgentInput
  calls: Array<Parameters<DispatchAgentInput>[0]>
} {
  const calls: Array<Parameters<DispatchAgentInput>[0]> = []
  const port: DispatchAgentInput = async (input) => {
    calls.push(input)
    return {
      to: 'fettle@agent-control-plane:T-09001',
      roomKey: 'T-09001',
      groupId: `EN-${calls.length.toString().padStart(5, '0')}`,
      envelopeId: `EN-${calls.length.toString().padStart(5, '0')}`,
    }
  }
  return { port, calls }
}

// ─── Group A: wrkq-task step ─────────────────────────────────────────────────

describe('executeNativeSideEffectStep — wrkq-task step (Phase B RED)', () => {
  test('a wrkq-task step creates-or-finds the task by its incident key, records the result as succeeded, and a retry replays it without calling the port', async () => {
    const store = createInMemoryJobsStore()
    try {
      const { jobRun } = makeJobRun(store)
      const createOrFindCalls: Array<Parameters<WrkqTaskPort['createOrFind']>[0]> = []
      const wrkqTaskPort: WrkqTaskPort = {
        async createOrFind(input) {
          createOrFindCalls.push(input)
          return {
            taskId: 'T-05001',
            projectId: input.projectId,
            taskPath: input.path,
            created: true,
          }
        },
      }
      const deps: NativeStepExecutorDeps = {
        store,
        wrkqTaskPort,
        sendPulpitMessage: makeSendPulpitMessage().port,
        dispatchAgentInput: makeDispatchAgentInput().port,
      }
      const canonicalEventId = 'evt_abc123def456'
      const stepInput = {
        jobRunId: jobRun.jobRunId,
        phase: 'sequence' as const,
        stepId: 'create_task',
        attempt: 1,
        stepKind: 'wrkq-task' as const,
        stepDef: {
          kind: 'wrkq-task',
          id: 'create_task',
          title: 'ACP health: dispatch timeout',
          container: 'agent-control-plane/inbox',
        },
        resolvedFields: { _canonicalEventId: canonicalEventId },
      }

      const result = await executeNativeSideEffectStep(deps, stepInput)

      const expectedPath =
        'agent-control-plane/inbox/acp-health-dispatch-timeout-evt-abc123def456-task'
      expect(createOrFindCalls).toHaveLength(1)
      expect(createOrFindCalls[0]?.key).toBe(`acp-health:dispatch-timeout:${canonicalEventId}:task`)
      expect(createOrFindCalls[0]?.path).toBe(expectedPath)
      const expectedResult = {
        taskId: 'T-05001',
        projectId: 'agent-control-plane',
        taskPath: expectedPath,
        created: true,
      }
      expect(result).toEqual({ kind: 'wrkq-task', result: expectedResult })
      const { jobStepRun } = store.jobStepRuns.getById(
        jobRun.jobRunId,
        'sequence',
        'create_task',
        1
      )
      expect(jobStepRun?.status).toBe('succeeded')
      expect(jobStepRun?.result).toEqual(expectedResult)

      // Scheduler retry of the now-succeeded step replays the stored result.
      const replay = await executeNativeSideEffectStep(deps, stepInput)
      expect(createOrFindCalls).toHaveLength(1)
      expect(replay).toEqual({ kind: 'wrkq-task', result: expectedResult })
    } finally {
      store.close()
    }
  })
})

// ─── Group B: pulpit-message step ────────────────────────────────────────────

describe('executeNativeSideEffectStep — pulpit-message step (Phase B RED)', () => {
  test('a pulpit-message step sends once with the job-run pulpit key and records the delivery as succeeded', async () => {
    const store = createInMemoryJobsStore()
    try {
      const { jobRun } = makeJobRun(store)

      store.jobStepRuns.updateStep(jobRun.jobRunId, 'sequence', 'create_task', 1, {
        status: 'succeeded',
        result: {
          taskId: 'T-05001',
          projectId: 'agent-control-plane',
          taskPath: 'agent-control-plane/inbox/x',
          created: true,
        },
        completedAt: '2026-06-19T10:00:01.000Z',
      })

      const { port: sendPulpitMessage, calls: pulpitCalls } = makeSendPulpitMessage()
      const deps: NativeStepExecutorDeps = {
        store,
        wrkqTaskPort: makeWrkqTaskPort(),
        sendPulpitMessage,
        dispatchAgentInput: makeDispatchAgentInput().port,
      }

      const result = await executeNativeSideEffectStep(deps, {
        jobRunId: jobRun.jobRunId,
        phase: 'sequence',
        stepId: 'notify_pulpit',
        attempt: 1,
        stepKind: 'pulpit-message',
        stepDef: {
          kind: 'pulpit-message',
          id: 'notify_pulpit',
          content: 'Incident task created.',
          binding: 'discord:primary',
        },
      })

      const idempotencyKey = `acp-health:dispatch-timeout:${jobRun.jobRunId}:pulpit`
      expect(pulpitCalls).toHaveLength(1)
      expect(pulpitCalls[0]).toEqual({
        idempotencyKey,
        text: 'Incident task created.',
        bindingId: 'discord:primary',
      })
      const expectedResult = {
        deliveryRequestId: 'dr_000001',
        bindingId: 'discord:primary',
        idempotencyKey,
      }
      expect(result).toEqual({ kind: 'pulpit-message', result: expectedResult })
      const { jobStepRun } = store.jobStepRuns.getById(
        jobRun.jobRunId,
        'sequence',
        'notify_pulpit',
        1
      )
      expect(jobStepRun?.status).toBe('succeeded')
      expect(jobStepRun?.result).toEqual(expectedResult)
    } finally {
      store.close()
    }
  })
})

// ─── Group C: agent-dispatch step ────────────────────────────────────────────

describe('executeNativeSideEffectStep — agent-dispatch step (Phase B RED)', () => {
  test('an agent-dispatch step dispatches once to the step target with its deterministic key and records the result', async () => {
    const store = createInMemoryJobsStore()
    try {
      const { jobRun } = makeJobRun(store)

      store.jobStepRuns.updateStep(jobRun.jobRunId, 'sequence', 'create_task', 1, {
        status: 'succeeded',
        result: {
          taskId: 'T-05001',
          projectId: 'agent-control-plane',
          taskPath: 'agent-control-plane/inbox/x',
          created: true,
        },
        completedAt: '2026-06-19T10:00:01.000Z',
      })
      store.jobStepRuns.updateStep(jobRun.jobRunId, 'sequence', 'notify_pulpit', 1, {
        status: 'succeeded',
        result: { deliveryRequestId: 'dr_001', bindingId: 'binding_001', idempotencyKey: 'k1' },
        completedAt: '2026-06-19T10:00:02.000Z',
      })

      const { port: dispatchAgentInput, calls: dispatchCalls } = makeDispatchAgentInput()
      const deps: NativeStepExecutorDeps = {
        store,
        wrkqTaskPort: makeWrkqTaskPort(),
        sendPulpitMessage: makeSendPulpitMessage().port,
        dispatchAgentInput,
      }

      const result = await executeNativeSideEffectStep(deps, {
        jobRunId: jobRun.jobRunId,
        phase: 'sequence',
        stepId: 'dispatch_fettle',
        attempt: 1,
        stepKind: 'agent-dispatch',
        stepDef: {
          kind: 'agent-dispatch',
          id: 'dispatch_fettle',
          scopeRef: 'agent:fettle:project:agent-control-plane:task:T-05001',
          laneRef: 'main',
        },
      })

      const idempotencyKey = `jobrun:${jobRun.jobRunId}:phase:sequence:step:dispatch_fettle:attempt:1`
      expect(dispatchCalls).toHaveLength(1)
      expect(dispatchCalls[0]).toEqual(
        expect.objectContaining({
          scopeRef: 'agent:fettle:project:agent-control-plane:task:T-05001',
          laneRef: 'main',
          idempotencyKey,
        })
      )
      expect(result.kind).toBe('agent-dispatch')
      if (result.kind !== 'agent-dispatch') return
      expect(result.result).toEqual(
        expect.objectContaining({
          to: 'fettle@agent-control-plane:T-09001',
          envelopeId: 'EN-00001',
          scopeRef: 'agent:fettle:project:agent-control-plane:task:T-05001',
          laneRef: 'main',
          idempotencyKey,
        })
      )
      const { jobStepRun } = store.jobStepRuns.getById(
        jobRun.jobRunId,
        'sequence',
        'dispatch_fettle',
        1
      )
      expect(jobStepRun?.status).toBe('succeeded')
      expect(jobStepRun?.result).toEqual(result.result)
    } finally {
      store.close()
    }
  })

  test('agent-dispatch sends health incident metadata on the dispatch call', async () => {
    const store = createInMemoryJobsStore()
    try {
      const { jobRun } = makeJobRun(store)

      store.jobStepRuns.updateStep(jobRun.jobRunId, 'sequence', 'create_task', 1, {
        status: 'succeeded',
        result: {
          taskId: 'T-05001',
          projectId: 'agent-control-plane',
          taskPath: 'agent-control-plane/inbox/x',
          created: true,
        },
        completedAt: '2026-06-19T10:00:01.000Z',
      })
      store.jobStepRuns.updateStep(jobRun.jobRunId, 'sequence', 'notify_pulpit', 1, {
        status: 'succeeded',
        result: { deliveryRequestId: 'dr_001', bindingId: 'b1', idempotencyKey: 'k1' },
        completedAt: '2026-06-19T10:00:02.000Z',
      })

      const capturedMeta: Array<Readonly<Record<string, unknown>> | undefined> = []
      const dispatchAgentInput: DispatchAgentInput = async (input) => {
        capturedMeta.push(input.meta)
        return { to: 'fettle@agent-control-plane:T-09001', envelopeId: 'EN-00001' }
      }

      const deps: NativeStepExecutorDeps = {
        store,
        wrkqTaskPort: makeWrkqTaskPort({ taskId: 'T-05001' }),
        sendPulpitMessage: makeSendPulpitMessage().port,
        dispatchAgentInput,
      }

      const canonicalEventId = 'evt_source_123'

      // RED: throws "not implemented"
      await executeNativeSideEffectStep(deps, {
        jobRunId: jobRun.jobRunId,
        phase: 'sequence',
        stepId: 'dispatch_fettle',
        attempt: 1,
        stepKind: 'agent-dispatch',
        stepDef: {
          kind: 'agent-dispatch',
          id: 'dispatch_fettle',
          scopeRef: 'agent:fettle:project:agent-control-plane:task:T-05001',
          laneRef: 'main',
        },
        resolvedFields: {
          _canonicalEventId: canonicalEventId,
        },
      })

      // Health incident metadata must be stamped
      const meta = capturedMeta[0]
      expect(meta).toBeDefined()
      const source = (meta as Record<string, unknown>)?.['source']
      expect(source).toBeDefined()
      expect((source as Record<string, unknown>)?.['kind']).toBe('acp-health-incident')
      expect((source as Record<string, unknown>)?.['jobRunId']).toBe(jobRun.jobRunId)
      expect((source as Record<string, unknown>)?.['incidentTaskId']).toBe('T-05001')
    } finally {
      store.close()
    }
  })
})

// ─── Group D: terminal step replay safety ────────────────────────────────────

describe('executeNativeSideEffectStep — terminal step replay safety (Phase B RED)', () => {
  test('re-running a succeeded step returns its stored result without calling the port', async () => {
    const store = createInMemoryJobsStore()
    try {
      const { jobRun } = makeJobRun(store)

      // Pre-populate succeeded step in the store (simulates prior executor run)
      store.jobStepRuns.updateStep(jobRun.jobRunId, 'sequence', 'create_task', 1, {
        status: 'succeeded',
        result: {
          taskId: 'T-09999',
          projectId: 'agent-control-plane',
          taskPath: 'stored-path',
          created: true,
        },
        completedAt: '2026-06-19T10:00:01.000Z',
      })

      const portCalled = { count: 0 }
      const wrkqTaskPort: WrkqTaskPort = {
        async createOrFind() {
          portCalled.count += 1
          return { taskId: 'T-NEW', projectId: 'p', taskPath: 'new-path', created: true }
        },
      }

      const deps: NativeStepExecutorDeps = {
        store,
        wrkqTaskPort,
        sendPulpitMessage: makeSendPulpitMessage().port,
        dispatchAgentInput: makeDispatchAgentInput().port,
      }

      // RED: throws "not implemented"
      const result = await executeNativeSideEffectStep(deps, {
        jobRunId: jobRun.jobRunId,
        phase: 'sequence',
        stepId: 'create_task',
        attempt: 1,
        stepKind: 'wrkq-task',
        stepDef: { kind: 'wrkq-task', id: 'create_task', title: 'x', container: 'y' },
      })

      // Port must NOT have been called — result comes from store
      expect(portCalled.count).toBe(0)
      if (result.kind === 'wrkq-task') {
        // Returns the persisted task id, not the port's new one
        expect(result.result.taskId).toBe('T-09999')
      }
    } finally {
      store.close()
    }
  })
})
