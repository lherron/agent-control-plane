import { describe, expect, test } from 'bun:test'

import { createInMemoryJobsStore } from 'acp-jobs-store'

import type { StoredRun } from '../domain/run-store.js'
import {
  ACP_HEALTH_SOURCE,
  DISPATCH_TIMEOUT_EVENT,
  DISPATCH_TIMEOUT_HEALTH_JOB_SLUG,
  emitDispatchTimeoutHealthEvent,
  ensureDispatchTimeoutHealthJob,
} from '../jobs/health-dispatch-timeout.js'

function run(overrides: Partial<StoredRun> = {}): StoredRun {
  return {
    runId: 'run_timeout_001',
    scopeRef: 'agent:cody:project:agent-control-plane:task:primary',
    laneRef: 'main',
    actor: { kind: 'system', id: 'test' },
    status: 'failed',
    errorCode: 'dispatch_timeout',
    errorMessage: 'no HRC launch correlation',
    createdAt: '2026-06-19T12:00:00.000Z',
    updatedAt: '2026-06-19T12:05:00.000Z',
    ...overrides,
  }
}

describe('dispatch timeout health wiring', () => {
  test('dispatch_timeout run emits one acp-health inbox event keyed by run, deduped on re-emit', () => {
    const store = createInMemoryJobsStore()
    try {
      const first = emitDispatchTimeoutHealthEvent({
        jobsStore: store,
        run: run(),
        originVia: 'input-queue-dispatcher',
        occurredAt: '2026-06-19T12:05:00.000Z',
      })
      const second = emitDispatchTimeoutHealthEvent({
        jobsStore: store,
        run: run(),
        originVia: 'input-queue-dispatcher',
        occurredAt: '2026-06-19T12:05:00.000Z',
      })

      expect(first).toMatchObject({
        inserted: true,
        skipped: false,
        eventId: 'acp-health:run.dispatch_timeout:run_timeout_001',
      })
      expect(second.inserted).toBe(false)

      const event = store.getInboxEvent('acp-health:run.dispatch_timeout:run_timeout_001').event
      expect(event).toBeDefined()
      expect(event?.source).toBe(ACP_HEALTH_SOURCE)
      expect(event?.event).toBe(DISPATCH_TIMEOUT_EVENT)
      expect(event?.payload).toMatchObject({
        source: ACP_HEALTH_SOURCE,
        event: DISPATCH_TIMEOUT_EVENT,
        subject: {
          type: 'acp-session-lane',
          id: 'agent:cody:project:agent-control-plane:task:primary#main',
        },
        payload: {
          runId: 'run_timeout_001',
          errorCode: 'dispatch_timeout',
        },
      })
    } finally {
      store.close()
    }
  })

  test('dispatch_timeout on a health-diagnostic run emits no health event (loop guard)', () => {
    const store = createInMemoryJobsStore()
    try {
      const result = emitDispatchTimeoutHealthEvent({
        jobsStore: store,
        run: run({
          metadata: {
            meta: {
              source: {
                kind: 'acp-health-incident',
                jobRunId: 'jrun_health',
                sourceEventId: 'acp-health:run.dispatch_timeout:source',
                incidentTaskId: 'T-09001',
              },
            },
          },
        }),
        originVia: 'interface-run-dispatcher',
      })

      expect(result).toEqual({ inserted: false, skipped: true })
      expect(
        store.getInboxEvent('acp-health:run.dispatch_timeout:run_timeout_001').event
      ).toBeUndefined()
    } finally {
      store.close()
    }
  })

  test('ensuring the dispatch-timeout fettle job sets event trigger, 300s cooldown, task->pulpit->dispatch', () => {
    const store = createInMemoryJobsStore()
    try {
      const job = ensureDispatchTimeoutHealthJob(store)

      expect(job.slug).toBe(DISPATCH_TIMEOUT_HEALTH_JOB_SLUG)
      expect(job.trigger).toMatchObject({
        kind: 'event',
        source: ACP_HEALTH_SOURCE,
        match: { event: DISPATCH_TIMEOUT_EVENT },
        cooldown: '300s',
      })
      expect(job.flow?.sequence.map((step) => [step.id, step.kind])).toEqual([
        ['create_task', 'wrkq-task'],
        ['notify_fettle', 'pulpit-message'],
        ['dispatch_fettle', 'agent-dispatch'],
      ])
    } finally {
      store.close()
    }
  })
})
