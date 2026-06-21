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
      inputAttemptId: `iat_${calls.length.toString().padStart(6, '0')}`,
      runId: `run_${calls.length.toString().padStart(6, '0')}`,
    }
  }
  return { port, calls }
}

// ─── Group A: wrkq-task step ─────────────────────────────────────────────────

describe('executeNativeSideEffectStep — wrkq-task step (Phase B RED)', () => {
  test('calls wrkqTaskPort.createOrFind and persists WrkqTaskStepResult to job_step_runs', async () => {
    const store = createInMemoryJobsStore()
    try {
      const { jobRun } = makeJobRun(store)
      const wrkqTaskPort = makeWrkqTaskPort()
      const { port: sendPulpitMessage } = makeSendPulpitMessage()
      const { port: dispatchAgentInput } = makeDispatchAgentInput()

      const deps: NativeStepExecutorDeps = {
        store,
        wrkqTaskPort,
        sendPulpitMessage,
        dispatchAgentInput,
      }

      // RED: throws "not implemented"
      const result = await executeNativeSideEffectStep(deps, {
        jobRunId: jobRun.jobRunId,
        phase: 'sequence',
        stepId: 'create_task',
        attempt: 1,
        stepKind: 'wrkq-task',
        stepDef: {
          kind: 'wrkq-task',
          id: 'create_task',
          title: 'ACP health: dispatch timeout',
          container: 'agent-control-plane/inbox',
        },
      })

      // Assertion 1: result shape
      expect(result.kind).toBe('wrkq-task')
      if (result.kind === 'wrkq-task') {
        expect(result.result.taskId).toBeDefined()
        expect(typeof result.result.taskId).toBe('string')
        expect(result.result.projectId).toBe('agent-control-plane')
        expect(typeof result.result.taskPath).toBe('string')
        expect(typeof result.result.created).toBe('boolean')
      }

      // Assertion 2: persisted to job_step_runs
      const { jobStepRun } = store.jobStepRuns.getById(
        jobRun.jobRunId,
        'sequence',
        'create_task',
        1
      )
      expect(jobStepRun?.status).toBe('succeeded')
      expect(jobStepRun?.result).toBeDefined()
      expect(jobStepRun?.result?.['taskId']).toBeDefined()
    } finally {
      store.close()
    }
  })

  test('wrkq-task step uses deterministic idempotency key: acp-health:dispatch-timeout:${canonicalEventId}:task', async () => {
    const store = createInMemoryJobsStore()
    try {
      const { jobRun } = makeJobRun(store)
      const createOrFindCalls: Array<Parameters<WrkqTaskPort['createOrFind']>[0]> = []
      const wrkqTaskPort: WrkqTaskPort = {
        async createOrFind(input) {
          createOrFindCalls.push(input)
          return {
            taskId: 'T-05001',
            projectId: 'agent-control-plane',
            taskPath: `agent-control-plane/inbox/${input.key}`,
            created: true,
          }
        },
      }
      const { port: sendPulpitMessage } = makeSendPulpitMessage()
      const { port: dispatchAgentInput } = makeDispatchAgentInput()

      const canonicalEventId = 'evt_abc123def456'
      const deps: NativeStepExecutorDeps = {
        store,
        wrkqTaskPort,
        sendPulpitMessage,
        dispatchAgentInput,
      }

      // RED: throws "not implemented"
      await executeNativeSideEffectStep(deps, {
        jobRunId: jobRun.jobRunId,
        phase: 'sequence',
        stepId: 'create_task',
        attempt: 1,
        stepKind: 'wrkq-task',
        stepDef: {
          kind: 'wrkq-task',
          id: 'create_task',
          title: 'ACP health: dispatch timeout',
          container: 'agent-control-plane/inbox',
        },
        // The resolved key is derived from the canonical event id
        resolvedFields: {
          _canonicalEventId: canonicalEventId,
        },
      })

      expect(createOrFindCalls).toHaveLength(1)
      // Key format: "acp-health:dispatch-timeout:${canonicalEventId}:task"
      expect(createOrFindCalls[0]?.key).toBe(`acp-health:dispatch-timeout:${canonicalEventId}:task`)
      expect(createOrFindCalls[0]?.path).toBe(
        'agent-control-plane/inbox/acp-health-dispatch-timeout-evt-abc123def456-task'
      )
    } finally {
      store.close()
    }
  })
})

// ─── Group B: pulpit-message step ────────────────────────────────────────────

describe('executeNativeSideEffectStep — pulpit-message step (Phase B RED)', () => {
  test('calls sendPulpitMessage with idempotency key and persists PulpitMessageStepResult', async () => {
    const store = createInMemoryJobsStore()
    try {
      const { jobRun } = makeJobRun(store)

      // Pre-set create_task as succeeded so notify_pulpit can proceed
      store.jobStepRuns.updateStep(jobRun.jobRunId, 'sequence', 'create_task', 1, {
        status: 'succeeded',
        result: {
          taskId: 'T-05001',
          projectId: 'agent-control-plane',
          taskPath: 'x',
          created: true,
        },
        completedAt: '2026-06-19T10:00:01.000Z',
      })

      const wrkqTaskPort = makeWrkqTaskPort()
      const { port: sendPulpitMessage, calls: pulpitCalls } = makeSendPulpitMessage()
      const { port: dispatchAgentInput } = makeDispatchAgentInput()

      const deps: NativeStepExecutorDeps = {
        store,
        wrkqTaskPort,
        sendPulpitMessage,
        dispatchAgentInput,
      }

      // RED: throws "not implemented"
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

      // Assertion 1: result shape
      expect(result.kind).toBe('pulpit-message')
      if (result.kind === 'pulpit-message') {
        expect(typeof result.result.deliveryRequestId).toBe('string')
        expect(typeof result.result.bindingId).toBe('string')
        expect(typeof result.result.idempotencyKey).toBe('string')
      }

      // Assertion 2: sendPulpitMessage called once
      expect(pulpitCalls).toHaveLength(1)

      // Assertion 3: persisted to store
      const { jobStepRun } = store.jobStepRuns.getById(
        jobRun.jobRunId,
        'sequence',
        'notify_pulpit',
        1
      )
      expect(jobStepRun?.status).toBe('succeeded')
      expect(jobStepRun?.result?.['idempotencyKey']).toBeDefined()
      expect(jobStepRun?.result?.['deliveryRequestId']).toBeDefined()
      expect(jobStepRun?.result?.['bindingId']).toBeDefined()
    } finally {
      store.close()
    }
  })

  test('pulpit-message step uses idempotency key: acp-health:dispatch-timeout:${jobRunId}:pulpit', async () => {
    const store = createInMemoryJobsStore()
    try {
      const { jobRun } = makeJobRun(store)

      store.jobStepRuns.updateStep(jobRun.jobRunId, 'sequence', 'create_task', 1, {
        status: 'succeeded',
        result: {
          taskId: 'T-05001',
          projectId: 'agent-control-plane',
          taskPath: 'x',
          created: true,
        },
        completedAt: '2026-06-19T10:00:01.000Z',
      })

      const capturedKeys: string[] = []
      const sendPulpitMessage: SendPulpitMessage = async (input) => {
        capturedKeys.push(input.idempotencyKey)
        return { deliveryRequestId: 'dr_001', bindingId: 'binding_001' }
      }
      const { port: dispatchAgentInput } = makeDispatchAgentInput()

      const deps: NativeStepExecutorDeps = {
        store,
        wrkqTaskPort: makeWrkqTaskPort(),
        sendPulpitMessage,
        dispatchAgentInput,
      }

      // RED: throws "not implemented"
      await executeNativeSideEffectStep(deps, {
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

      // Key format: "acp-health:dispatch-timeout:${jobRunId}:pulpit"
      expect(capturedKeys[0]).toBe(`acp-health:dispatch-timeout:${jobRun.jobRunId}:pulpit`)
    } finally {
      store.close()
    }
  })
})

// ─── Group C: agent-dispatch step ────────────────────────────────────────────

describe('executeNativeSideEffectStep — agent-dispatch step (Phase B RED)', () => {
  test('calls dispatchAgentInput with deterministic step idempotency key and persists result', async () => {
    const store = createInMemoryJobsStore()
    try {
      const { jobRun } = makeJobRun(store)

      // Pre-set prior steps as succeeded
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

      // RED: throws "not implemented"
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

      // Assertion 1: result shape
      expect(result.kind).toBe('agent-dispatch')
      if (result.kind === 'agent-dispatch') {
        expect(typeof result.result.inputAttemptId).toBe('string')
        expect(typeof result.result.runId).toBe('string')
        expect(typeof result.result.scopeRef).toBe('string')
        expect(typeof result.result.laneRef).toBe('string')
        expect(typeof result.result.idempotencyKey).toBe('string')
      }

      // Assertion 2: dispatch called exactly once
      expect(dispatchCalls).toHaveLength(1)

      // Assertion 3: persisted to store
      const { jobStepRun } = store.jobStepRuns.getById(
        jobRun.jobRunId,
        'sequence',
        'dispatch_fettle',
        1
      )
      expect(jobStepRun?.status).toBe('succeeded')
      expect(jobStepRun?.result?.['inputAttemptId']).toBeDefined()
      expect(jobStepRun?.result?.['idempotencyKey']).toBeDefined()
    } finally {
      store.close()
    }
  })

  test('agent-dispatch idempotency key matches: jobrun:${jobRunId}:phase:sequence:step:dispatch_fettle:attempt:1', async () => {
    const store = createInMemoryJobsStore()
    try {
      const { jobRun } = makeJobRun(store)

      store.jobStepRuns.updateStep(jobRun.jobRunId, 'sequence', 'create_task', 1, {
        status: 'succeeded',
        result: {
          taskId: 'T-05001',
          projectId: 'agent-control-plane',
          taskPath: 'x',
          created: true,
        },
        completedAt: '2026-06-19T10:00:01.000Z',
      })
      store.jobStepRuns.updateStep(jobRun.jobRunId, 'sequence', 'notify_pulpit', 1, {
        status: 'succeeded',
        result: { deliveryRequestId: 'dr_001', bindingId: 'b1', idempotencyKey: 'k1' },
        completedAt: '2026-06-19T10:00:02.000Z',
      })

      const capturedKeys: string[] = []
      const dispatchAgentInput: DispatchAgentInput = async (input) => {
        capturedKeys.push(input.idempotencyKey)
        return { inputAttemptId: 'iat_001', runId: 'run_001' }
      }

      const deps: NativeStepExecutorDeps = {
        store,
        wrkqTaskPort: makeWrkqTaskPort(),
        sendPulpitMessage: makeSendPulpitMessage().port,
        dispatchAgentInput,
      }

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
      })

      // Key format: "jobrun:${jobRunId}:phase:sequence:step:dispatch_fettle:attempt:1"
      expect(capturedKeys[0]).toBe(
        `jobrun:${jobRun.jobRunId}:phase:sequence:step:dispatch_fettle:attempt:1`
      )
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
        return { inputAttemptId: 'iat_001', runId: 'run_001' }
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

  test('agent-dispatch dispatches to agent:fettle:project:agent-control-plane:task:${taskId}', async () => {
    const store = createInMemoryJobsStore()
    try {
      const { jobRun } = makeJobRun(store)

      store.jobStepRuns.updateStep(jobRun.jobRunId, 'sequence', 'create_task', 1, {
        status: 'succeeded',
        result: {
          taskId: 'T-05001',
          projectId: 'agent-control-plane',
          taskPath: 'x',
          created: true,
        },
        completedAt: '2026-06-19T10:00:01.000Z',
      })
      store.jobStepRuns.updateStep(jobRun.jobRunId, 'sequence', 'notify_pulpit', 1, {
        status: 'succeeded',
        result: { deliveryRequestId: 'dr_001', bindingId: 'b1', idempotencyKey: 'k1' },
        completedAt: '2026-06-19T10:00:02.000Z',
      })

      const capturedScopeRefs: string[] = []
      const capturedLaneRefs: string[] = []
      const dispatchAgentInput: DispatchAgentInput = async (input) => {
        capturedScopeRefs.push(input.scopeRef)
        capturedLaneRefs.push(input.laneRef)
        return { inputAttemptId: 'iat_001', runId: 'run_001' }
      }

      const deps: NativeStepExecutorDeps = {
        store,
        wrkqTaskPort: makeWrkqTaskPort({ taskId: 'T-05001' }),
        sendPulpitMessage: makeSendPulpitMessage().port,
        dispatchAgentInput,
      }

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
          // scopeRef is resolved from the create_task result's taskId
          scopeRef: 'agent:fettle:project:agent-control-plane:task:T-05001',
          laneRef: 'main',
        },
      })

      // dispatch target: agent:fettle:project:agent-control-plane:task:${taskId} lane main
      expect(capturedScopeRefs[0]).toBe('agent:fettle:project:agent-control-plane:task:T-05001')
      expect(capturedLaneRefs[0]).toBe('main')
    } finally {
      store.close()
    }
  })
})

// ─── Group D: terminal step replay safety ────────────────────────────────────

describe('executeNativeSideEffectStep — terminal step replay safety (Phase B RED)', () => {
  test('a succeeded step is NOT re-executed when executeNativeSideEffectStep is called again', async () => {
    const store = createInMemoryJobsStore()
    try {
      const { jobRun } = makeJobRun(store)

      const createOrFindCallCount = { count: 0 }
      const wrkqTaskPort = makeWrkqTaskPort({ createCount: createOrFindCallCount })
      const { port: sendPulpitMessage } = makeSendPulpitMessage()
      const { port: dispatchAgentInput } = makeDispatchAgentInput()

      const deps: NativeStepExecutorDeps = {
        store,
        wrkqTaskPort,
        sendPulpitMessage,
        dispatchAgentInput,
      }

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
      }

      // First call: executes the step
      // RED: throws "not implemented"
      const result1 = await executeNativeSideEffectStep(deps, stepInput)
      expect(result1.kind).toBe('wrkq-task')

      // Step row is now succeeded; reset call count
      createOrFindCallCount.count = 0

      // Second call (scheduler retry): must NOT re-execute the step
      const result2 = await executeNativeSideEffectStep(deps, stepInput)
      expect(result2.kind).toBe('wrkq-task')

      // Port must NOT have been called again
      expect(createOrFindCallCount.count).toBe(0)

      // Result must be the same taskId as the first call
      if (result1.kind === 'wrkq-task' && result2.kind === 'wrkq-task') {
        expect(result2.result.taskId).toBe(result1.result.taskId)
      }
    } finally {
      store.close()
    }
  })

  test('terminal step result is returned from persisted result_json, not re-fetched from port', async () => {
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
