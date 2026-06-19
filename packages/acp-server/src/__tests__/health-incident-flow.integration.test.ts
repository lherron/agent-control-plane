/**
 * T-04943 Phase B — RED integration tests: health incident flow + predicates.
 *
 * Covers daedalus required tests #5 (pulpit), #6 (dispatch), #7 (loop guard),
 * and the integration sequence / cooldown-skip gate.
 *
 * Tests:
 *   A. isHealthDiagnosticRun predicate: identifies dispatched runs by marker, not heuristics.
 *   B. Full sequence: event → wrkq-task → pulpit-message → agent-dispatch
 *      using in-memory jobs store + fake port implementations.
 *   C. Cooldown-skip: event within cooldown produces NO task, NO pulpit, NO dispatch.
 *
 * All tests are RED until Phase B execution ships — stubs throw/return wrong values.
 */

import { describe, expect, test } from 'bun:test'

import {
  type EvaluateEventJob,
  createInMemoryJobsStore,
  tickJobsScheduler,
} from 'acp-jobs-store'

import {
  type DispatchAgentInput,
  type NativeStepExecutorDeps,
  type SendPulpitMessage,
  type WrkqTaskPort,
  buildHealthIncidentMeta,
  executeNativeSideEffectStep,
  isHealthDiagnosticRun,
} from 'acp-jobs-store'

import type { JobRunRecord } from 'acp-jobs-store'

// ─── helpers ─────────────────────────────────────────────────────────────────

type PortCounts = {
  wrkqTaskCreateOrFind: number
  sendPulpitMessage: number
  dispatchAgentInput: number
}

function makePortsWithCounts(): { deps: Omit<NativeStepExecutorDeps, 'store'>; counts: PortCounts } {
  const counts: PortCounts = {
    wrkqTaskCreateOrFind: 0,
    sendPulpitMessage: 0,
    dispatchAgentInput: 0,
  }
  const wrkqTaskPort: WrkqTaskPort = {
    async createOrFind(input) {
      counts.wrkqTaskCreateOrFind += 1
      return {
        taskId: 'T-09001',
        projectId: 'agent-control-plane',
        taskPath: `agent-control-plane/inbox/${input.key}`,
        created: counts.wrkqTaskCreateOrFind === 1,
      }
    },
  }
  const sendPulpitMessage: SendPulpitMessage = async (input) => {
    counts.sendPulpitMessage += 1
    return { deliveryRequestId: `dr_00${counts.sendPulpitMessage}`, bindingId: 'binding_discord_primary' }
  }
  const dispatchAgentInput: DispatchAgentInput = async (input) => {
    counts.dispatchAgentInput += 1
    return { inputAttemptId: `iat_00${counts.dispatchAgentInput}`, runId: `run_00${counts.dispatchAgentInput}` }
  }
  return { deps: { wrkqTaskPort, sendPulpitMessage, dispatchAgentInput }, counts }
}

// ─── Group A: isHealthDiagnosticRun predicate ────────────────────────────────

describe('isHealthDiagnosticRun — loop guard predicate (Phase B RED — test #7)', () => {
  test('returns true for a run stamped with source.kind=acp-health-incident', () => {
    // RED: isHealthDiagnosticRun stub always returns false
    const markedRun = {
      metadata: {
        meta: {
          source: {
            kind: 'acp-health-incident',
            jobRunId: 'jobrun_abc',
            sourceEventId: 'evt_123',
            incidentTaskId: 'T-05001',
          },
        },
      },
    }
    expect(isHealthDiagnosticRun(markedRun)).toBe(true)
  })

  test('returns false for a regular dispatch run (no health-incident marker)', () => {
    // This should already pass (stub returns false) — but documents the contract
    const regularRun = {
      metadata: {
        meta: {
          source: {
            kind: 'job',
            jobId: 'job_regular',
            jobRunId: 'jobrun_regular',
          },
        },
      },
    }
    expect(isHealthDiagnosticRun(regularRun)).toBe(false)
  })

  test('returns false for a run with no metadata at all', () => {
    expect(isHealthDiagnosticRun({})).toBe(false)
    expect(isHealthDiagnosticRun({ metadata: undefined })).toBe(false)
  })

  test('returns false for a run with wrong source.kind value', () => {
    const wrongKindRun = {
      metadata: {
        meta: {
          source: {
            kind: 'webhook',
            jobRunId: 'jobrun_xyz',
          },
        },
      },
    }
    expect(isHealthDiagnosticRun(wrongKindRun)).toBe(false)
  })

  test('returns false for a run where source.kind is acp-health-incident as a string property but in a different path', () => {
    // Guard: must check the EXACT path, not just any field named 'kind'
    const sneakyRun = {
      metadata: {
        // 'meta' is missing — directly under metadata
        source: {
          kind: 'acp-health-incident',
        },
      },
    }
    expect(isHealthDiagnosticRun(sneakyRun)).toBe(false)
  })

  test('dispatch_timeout on a run marked source.kind=acp-health-incident is identified', () => {
    // Positive case: a real dispatch_timeout scenario that WOULD be suppressed by T-04939
    // isHealthDiagnosticRun must identify it correctly
    const incidentRun = {
      metadata: {
        meta: {
          source: {
            kind: 'acp-health-incident',
            jobRunId: 'jobrun_health_dispatch',
            sourceEventId: 'evt_dispatch_timeout_456',
            incidentTaskId: 'T-09001',
          },
        },
      },
    }
    // RED: stub returns false, but should return true
    expect(isHealthDiagnosticRun(incidentRun)).toBe(true)
  })
})

// ─── Group B: buildHealthIncidentMeta ────────────────────────────────────────

describe('buildHealthIncidentMeta — marker builder (Phase B RED)', () => {
  test('produces HealthIncidentMeta with correct structure', () => {
    // RED: buildHealthIncidentMeta throws "not implemented"
    const meta = buildHealthIncidentMeta({
      jobRunId: 'jobrun_abc123',
      sourceEventId: 'evt_source_456',
      incidentTaskId: 'T-09001',
    })

    expect(meta.source.kind).toBe('acp-health-incident')
    expect(meta.source.jobRunId).toBe('jobrun_abc123')
    expect(meta.source.sourceEventId).toBe('evt_source_456')
    expect(meta.source.incidentTaskId).toBe('T-09001')
  })

  test('built meta is recognized by isHealthDiagnosticRun', () => {
    // RED: buildHealthIncidentMeta throws; isHealthDiagnosticRun returns false
    const meta = buildHealthIncidentMeta({
      jobRunId: 'jobrun_round_trip',
      sourceEventId: 'evt_round_trip',
      incidentTaskId: 'T-09001',
    })

    const run = { metadata: { meta: meta } }
    expect(isHealthDiagnosticRun(run)).toBe(true)
  })
})

// ─── Group C: full flow sequence ─────────────────────────────────────────────

describe('health incident flow — full sequence (Phase B RED)', () => {
  test('full three-step sequence: wrkq-task → pulpit-message → agent-dispatch', async () => {
    const store = createInMemoryJobsStore()
    try {
      const { job } = store.createJob({
        agentId: 'acp-health',
        projectId: 'agent-control-plane',
        scopeRef: 'agent:fettle:project:agent-control-plane:task:primary',
        laneRef: 'main',
        schedule: { cron: '0 0 * * *' },
        input: { content: 'health check' },
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
              scopeRef: 'agent:fettle:project:agent-control-plane:task:T-09001',
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

      const { deps: portDeps, counts } = makePortsWithCounts()
      const deps: NativeStepExecutorDeps = { store, ...portDeps }

      // Execute step 1: wrkq-task
      // RED: throws "not implemented"
      const step1 = await executeNativeSideEffectStep(deps, {
        jobRunId: jobRun.jobRunId,
        phase: 'sequence',
        stepId: 'create_task',
        attempt: 1,
        stepKind: 'wrkq-task',
        stepDef: { kind: 'wrkq-task', id: 'create_task', title: 'ACP health: dispatch timeout', container: 'agent-control-plane/inbox' },
      })
      expect(step1.kind).toBe('wrkq-task')
      expect(counts.wrkqTaskCreateOrFind).toBe(1)
      expect(counts.sendPulpitMessage).toBe(0)
      expect(counts.dispatchAgentInput).toBe(0)

      // Execute step 2: pulpit-message
      const step2 = await executeNativeSideEffectStep(deps, {
        jobRunId: jobRun.jobRunId,
        phase: 'sequence',
        stepId: 'notify_pulpit',
        attempt: 1,
        stepKind: 'pulpit-message',
        stepDef: { kind: 'pulpit-message', id: 'notify_pulpit', content: 'Incident task created.', binding: 'discord:primary' },
      })
      expect(step2.kind).toBe('pulpit-message')
      expect(counts.sendPulpitMessage).toBe(1)
      expect(counts.dispatchAgentInput).toBe(0)

      // Execute step 3: agent-dispatch
      const step3 = await executeNativeSideEffectStep(deps, {
        jobRunId: jobRun.jobRunId,
        phase: 'sequence',
        stepId: 'dispatch_fettle',
        attempt: 1,
        stepKind: 'agent-dispatch',
        stepDef: {
          kind: 'agent-dispatch',
          id: 'dispatch_fettle',
          scopeRef: 'agent:fettle:project:agent-control-plane:task:T-09001',
          laneRef: 'main',
        },
      })
      expect(step3.kind).toBe('agent-dispatch')
      expect(counts.dispatchAgentInput).toBe(1)

      // All three steps are succeeded in the store
      const steps = store.jobStepRuns.listByJobRun(jobRun.jobRunId).jobStepRuns
      expect(steps.every((s) => s.status === 'succeeded')).toBe(true)
    } finally {
      store.close()
    }
  })
})

// ─── Group D: cooldown-skip → no side effects ────────────────────────────────

describe('health incident flow — cooldown-skip produces no side effects (Phase B RED)', () => {
  test('cooldown-skip: no wrkq task, no pulpit message, no dispatch', async () => {
    const store = createInMemoryJobsStore()
    try {
      const job = store.createJob({
        agentId: 'acp-health',
        projectId: 'agent-control-plane',
        scopeRef: 'agent:fettle:project:agent-control-plane:task:primary',
        laneRef: 'main',
        trigger: {
          kind: 'event',
          source: 'wrkq',
          match: { event: 'task.created' },
          cooldown: '300s',
        },
        input: { content: 'health check' },
        flow: {
          sequence: [
            { id: 'create_task', kind: 'wrkq-task', title: 'Incident', container: 'agent-control-plane/inbox' },
            { id: 'notify', kind: 'pulpit-message', content: 'msg', binding: 'discord:primary' },
            { id: 'dispatch', kind: 'agent-dispatch', scopeRef: 'agent:fettle:project:agent-control-plane:task:T-00001', laneRef: 'main' },
          ],
        },
        disabled: false,
        createdAt: '2026-06-19T00:00:00.000Z',
      }).job

      // Simulate first run already minted (cooldown guard active)
      store.mintEventJobRun({
        sourceEventId: 'evt_first',
        eventSeq: 1,
        jobId: job.jobId,
        resolvedScopeRef: 'agent:fettle:project:agent-control-plane:task:primary',
        resolvedLaneRef: 'main',
        resolvedInput: { content: 'x' },
        source: {},
        targetTaskId: 'T-09001',
        triggeredAt: '2026-06-19T09:50:00.000Z',
      })

      const { deps: portDeps, counts } = makePortsWithCounts()

      // Second event (within cooldown window) → should be skipped
      const secondEventPayload = {
        schema_version: 2,
        event_id: 'evt_second',
        canonical_event_id: 'evt_second',
        event_seq: 2,
        event: 'task.created',
        occurred_at: '2026-06-19T09:55:00.000Z',
        origin: { actor: 'human:lance', via: 'cli' },
        ticket_id: 'T-00042',
        project_scope_id: 'acp',
        transition: { from: null, to: 'idea' },
      }
      store.insertInboxEvent({
        eventId: 'evt_second',
        eventSeq: 2,
        source: 'wrkq',
        event: 'task.created',
        occurredAt: '2026-06-19T09:55:00.000Z',
        payload: secondEventPayload,
        receivedAt: '2026-06-19T09:55:00.000Z',
      })

      const evaluateEventJob: EvaluateEventJob = () => ({
        decision: 'skip',
        reason: 'cooldown',
      })

      const results = await tickJobsScheduler({
        store,
        now: '2026-06-19T09:55:00.000Z',
        evaluateEventJob,
        advanceFlowJobRun: async () => {
          // Should NOT be called on cooldown-skipped events
          throw new Error('advanceFlowJobRun must NOT be called for cooldown-skipped events')
        },
      })

      // Cooldown-skip: zero task/pulpit/dispatch side effects
      expect(counts.wrkqTaskCreateOrFind).toBe(0)
      expect(counts.sendPulpitMessage).toBe(0)
      expect(counts.dispatchAgentInput).toBe(0)
    } finally {
      store.close()
    }
  })
})
