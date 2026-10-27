/**
 * T-04943 Phase B — RED tests: step-output ref resolution at runtime.
 *
 * Covers daedalus required test #4 (resolution portion):
 *   - A consuming step reads the persisted prior job_step_runs(...).result_json[field]
 *     from the SAME job run, NOT in-memory state.
 *   - Fails CLOSED (returns undefined, no external side effect) for:
 *       missing step row                  (no row in store)
 *       non-succeeded step                (status != 'succeeded')
 *       field not in result               (missing key)
 *       wrong-typed field value           (not a string)
 *       later step / not yet run          (step exists but still pending)
 *
 * All tests assert behaviour the current codebase does NOT yet produce
 * (resolveStepOutputRef is a stub that throws) — they are RED until
 * Phase B implementation ships.
 */

import { describe, expect, test } from 'bun:test'

import { createInMemoryJobsStore } from '../index.js'
import { resolveStepOutputRef } from '../native-step-executor.js'

// ─── helpers ─────────────────────────────────────────────────────────────────

function makeJobRun(store: ReturnType<typeof createInMemoryJobsStore>) {
  const { job } = store.createJob({
    agentId: 'fettle',
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
          title: 'Incident',
          container: 'agent-control-plane/inbox',
        },
        {
          id: 'notify',
          kind: 'pulpit-message',
          content: 'Task created.',
          binding: 'discord:primary',
        },
      ],
    },
    disabled: false,
    createdAt: '2026-06-19T00:00:00.000Z',
  })

  const { jobRun } = store.appendJobRun({
    jobId: job.jobId,
    triggeredAt: '2026-06-19T10:00:00.000Z',
    triggeredBy: 'schedule',
    status: 'running',
    actor: { kind: 'system', id: 'acp-scheduler' },
    actorStamp: 'system:acp-scheduler',
  })

  // Insert step rows
  store.jobStepRuns.insertMany(jobRun.jobRunId, 'sequence', [
    { stepId: 'create_task', status: 'pending', attempt: 1 },
    { stepId: 'notify', status: 'pending', attempt: 1 },
  ])

  return { job, jobRun }
}

// ─── Group A: successful resolution ─────────────────────────────────────────

describe('resolveStepOutputRef — successful resolution (Phase B RED)', () => {
  test('reads taskId from a succeeded wrkq-task step result_json', () => {
    const store = createInMemoryJobsStore()
    try {
      const { jobRun } = makeJobRun(store)

      // Simulate: create_task step succeeded with result
      store.jobStepRuns.updateStep(jobRun.jobRunId, 'sequence', 'create_task', 1, {
        status: 'succeeded',
        result: {
          taskId: 'T-05001',
          projectId: 'agent-control-plane',
          taskPath: 'agent-control-plane/inbox/incident-evt123:task',
          created: true,
        },
        completedAt: '2026-06-19T10:00:01.000Z',
      })

      // RED: resolveStepOutputRef throws "not implemented"
      const taskId = resolveStepOutputRef(store, jobRun.jobRunId, 'sequence', {
        $step: 'create_task',
        field: 'taskId',
      })
      expect(taskId).toBe('T-05001')
      expect(
        resolveStepOutputRef(store, jobRun.jobRunId, 'sequence', {
          $step: 'create_task',
          field: 'projectId',
        })
      ).toBe('agent-control-plane')
    } finally {
      store.close()
    }
  })
})

// ─── Group B: fail-closed for missing step ───────────────────────────────────

describe('resolveStepOutputRef — fail CLOSED for missing step (Phase B RED)', () => {
  test('returns undefined when the referenced step id has no row in the store', () => {
    const store = createInMemoryJobsStore()
    try {
      const { jobRun } = makeJobRun(store)

      // RED: resolveStepOutputRef throws "not implemented"
      const result = resolveStepOutputRef(store, jobRun.jobRunId, 'sequence', {
        $step: 'nonexistent_step',
        field: 'taskId',
      })
      // Should fail closed: undefined, NOT throw
      expect(result).toBeUndefined()
    } finally {
      store.close()
    }
  })

  test('returns undefined for a step id from a DIFFERENT job run', () => {
    const store = createInMemoryJobsStore()
    try {
      makeJobRun(store)

      // Different job run's step — cross-run contamination must not happen
      const result = resolveStepOutputRef(store, 'jobrun_other_totally_different', 'sequence', {
        $step: 'create_task',
        field: 'taskId',
      })
      expect(result).toBeUndefined()
    } finally {
      store.close()
    }
  })
})

// ─── Group C: fail-closed for non-succeeded step ─────────────────────────────

describe('resolveStepOutputRef — fail CLOSED for non-succeeded step (Phase B RED)', () => {
  test.each(['pending', 'running', 'failed', 'cancelled'] as const)(
    'returns undefined for %s even when the step has a result',
    (status) => {
      const store = createInMemoryJobsStore()
      try {
        const { jobRun } = makeJobRun(store)
        store.jobStepRuns.updateStep(jobRun.jobRunId, 'sequence', 'create_task', 1, {
          status,
          result: { taskId: 'T-05001' },
        })
        expect(
          resolveStepOutputRef(store, jobRun.jobRunId, 'sequence', {
            $step: 'create_task',
            field: 'taskId',
          })
        ).toBeUndefined()
      } finally {
        store.close()
      }
    }
  )
})

// ─── Group D: fail-closed for bad result shape ───────────────────────────────

describe('resolveStepOutputRef — fail CLOSED for wrong-typed / missing field (Phase B RED)', () => {
  test('returns undefined when the requested field is not present in result_json', () => {
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
          numericField: 42,
        },
        completedAt: '2026-06-19T10:00:01.000Z',
      })

      expect(
        resolveStepOutputRef(store, jobRun.jobRunId, 'sequence', {
          $step: 'create_task',
          field: 'numericField',
        })
      ).toBeUndefined()
      expect(
        resolveStepOutputRef(store, jobRun.jobRunId, 'sequence', {
          $step: 'create_task',
          field: 'created',
        })
      ).toBeUndefined()

      // 'deliveryRequestId' is NOT in the wrkq-task result
      const result = resolveStepOutputRef(store, jobRun.jobRunId, 'sequence', {
        $step: 'create_task',
        field: 'deliveryRequestId',
      })
      // RED: fails closed — undefined, not throw
      expect(result).toBeUndefined()
    } finally {
      store.close()
    }
  })

  test('returns undefined when result_json is null / step has no result', () => {
    const store = createInMemoryJobsStore()
    try {
      const { jobRun } = makeJobRun(store)

      // Succeeded but no result (edge case: step marked succeeded without persisting result)
      store.jobStepRuns.updateStep(jobRun.jobRunId, 'sequence', 'create_task', 1, {
        status: 'succeeded',
        result: null,
        completedAt: '2026-06-19T10:00:01.000Z',
      })

      const result = resolveStepOutputRef(store, jobRun.jobRunId, 'sequence', {
        $step: 'create_task',
        field: 'taskId',
      })
      // RED
      expect(result).toBeUndefined()
    } finally {
      store.close()
    }
  })
})
