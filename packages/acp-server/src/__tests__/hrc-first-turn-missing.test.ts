import { describe, expect, spyOn, test } from 'bun:test'

import { createInMemoryJobsStore, tickJobsScheduler } from 'acp-jobs-store'

import { createEventJobEvaluator } from '../jobs/event-job-evaluator.js'
import { advanceJobFlow } from '../jobs/flow-engine.js'
import {
  HRC_EVENT_SOURCE,
  HRC_FIRST_TURN_MISSING_EVENT,
  HRC_FIRST_TURN_MISSING_JOB_SLUG,
  ensureHrcFirstTurnMissingJob,
} from '../jobs/hrc-first-turn-missing.js'

function hrcEnvelope() {
  return {
    schema_version: 1,
    source: HRC_EVENT_SOURCE,
    event_id: 'max3:42',
    canonical_event_id: 'hrc:max3:42',
    event_seq: 42,
    event: HRC_FIRST_TURN_MISSING_EVENT,
    occurred_at: '2026-08-14T20:00:00Z',
    subject: { type: 'hrc-runtime', id: 'runtime-42' },
    origin: { actor: 'agent:cody', kind: 'agent' },
    payload: {
      nodeId: 'max3',
      runtimeId: 'runtime-42',
      scopeRef: 'agent:cody:project:agent-control-plane:task:T-07237',
      generation: 3,
      invocationId: 'invocation-42',
      runId: 'run-42',
      tripEventId: '42',
      retrievalHint: 'hrc runtime diagnostics 42',
    },
  }
}

function flowDeps(
  store: ReturnType<typeof createInMemoryJobsStore>,
  nodeId: string,
  calls: Array<{ scopeRef: string; content: string }>
) {
  return {
    jobsStore: store,
    defaultActor: { kind: 'system', id: 'test' },
    jobNodeIdentityAuthority: {
      getDiagnostics: () => ({
        startupState: 'ready',
        baseline: { nodeId, mode: 'single-node' },
        current: { nodeId, mode: 'single-node' },
        quiesced: false,
      }),
    },
    nativeStepExecutor: {
      wrkqTaskPort: {
        createOrFind: async () => {
          throw new Error('wrkq task step must not run')
        },
      },
      sendPulpitMessage: async () => {
        throw new Error('pulpit step must not run')
      },
      dispatchAgentInput: async (input: { scopeRef: string; content: string }) => {
        calls.push({ scopeRef: input.scopeRef, content: input.content })
        return { inputAttemptId: `iat-${calls.length}`, runId: `run-dispatched-${calls.length}` }
      },
    },
  }
}

describe('HRC first-turn-missing built-in job', () => {
  test('is slug-idempotent and preserves the frozen static dispatch contract', () => {
    const store = createInMemoryJobsStore()
    try {
      const first = ensureHrcFirstTurnMissingJob(store)
      const second = ensureHrcFirstTurnMissingJob(store)

      expect(second.jobId).toBe(first.jobId)
      expect(store.listJobs({ projectId: 'agent-control-plane' }).jobs).toHaveLength(1)
      expect(first).toMatchObject({
        slug: HRC_FIRST_TURN_MISSING_JOB_SLUG,
        agentId: 'fettle',
        scopeRef: 'agent:fettle:project:agent-control-plane:task:primary',
        laneRef: 'main',
        trigger: {
          kind: 'event',
          source: HRC_EVENT_SOURCE,
          match: { event: HRC_FIRST_TURN_MISSING_EVENT },
          cooldown: '300s',
          originPolicy: { agent: 'allow' },
        },
      })
      expect(first.input.content).toEndWith('{{payload.retrievalHint}}')
      expect(first.flow?.sequence.map((step) => [step.id, step.kind])).toEqual([
        ['verify_local_node', 'probe'],
        ['notify_fettle', 'agent-dispatch'],
      ])
    } finally {
      store.close()
    }
  })

  test('rev3 envelope on the co-resident HRC node dispatches with verbatim retrieval hint', async () => {
    const store = createInMemoryJobsStore()
    try {
      const job = ensureHrcFirstTurnMissingJob(store)
      const envelope = hrcEnvelope()
      store.insertInboxEvent({
        eventId: envelope.event_id,
        eventSeq: envelope.event_seq,
        source: envelope.source,
        event: envelope.event,
        occurredAt: envelope.occurred_at,
        payload: envelope,
      })
      const calls: Array<{ scopeRef: string; content: string }> = []

      const first = await tickJobsScheduler({
        store,
        now: '2026-08-14T20:01:00Z',
        evaluateEventJob: createEventJobEvaluator(),
        advanceFlowJobRun: (entry) =>
          advanceJobFlow({
            deps: flowDeps(store, 'max3', calls) as never,
            job: entry.job,
            jobRun: entry.jobRun,
            now: '2026-08-14T20:01:00Z',
          }),
      })

      expect(first.filter((run) => run.triggeredBy === 'webhook')).toHaveLength(1)
      expect(calls).toEqual([
        {
          scopeRef: 'agent:fettle:project:agent-control-plane:task:primary',
          content:
            'HRC first-turn-missing notification\n\nNode: max3\nScope: agent:cody:project:agent-control-plane:task:T-07237\nRuntime: runtime-42\nGeneration: 3\nInvocation: invocation-42\nRun: run-42\n\nhrc runtime diagnostics 42',
        },
      ])
      expect(store.listJobRuns(job.jobId).jobRuns).toHaveLength(1)

      store.insertInboxEvent({
        eventId: envelope.event_id,
        eventSeq: envelope.event_seq,
        source: envelope.source,
        event: envelope.event,
        occurredAt: envelope.occurred_at,
        payload: envelope,
      })
      await tickJobsScheduler({
        store,
        now: '2026-08-14T20:02:00Z',
        evaluateEventJob: createEventJobEvaluator(),
        advanceFlowJobRun: (entry) =>
          advanceJobFlow({
            deps: flowDeps(store, 'max3', calls) as never,
            job: entry.job,
            jobRun: entry.jobRun,
            now: '2026-08-14T20:02:00Z',
          }),
      })
      expect(calls).toHaveLength(1)
      expect(store.listJobRuns(job.jobId).jobRuns).toHaveLength(1)
    } finally {
      store.close()
    }
  })

  test('nodeId mismatch is a warned no-op with no dispatch', async () => {
    const store = createInMemoryJobsStore()
    const warn = spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const job = ensureHrcFirstTurnMissingJob(store)
      const base = hrcEnvelope()
      const envelope = {
        ...base,
        event_id: 'remote-node:42',
        canonical_event_id: 'hrc:remote-node:42',
        payload: { ...base.payload, nodeId: 'remote-node' },
      }
      store.insertInboxEvent({
        eventId: envelope.event_id,
        eventSeq: envelope.event_seq,
        source: envelope.source,
        event: envelope.event,
        occurredAt: envelope.occurred_at,
        payload: envelope,
      })
      const calls: Array<{ scopeRef: string; content: string }> = []

      await tickJobsScheduler({
        store,
        now: '2026-08-14T20:01:00Z',
        evaluateEventJob: createEventJobEvaluator(),
        advanceFlowJobRun: (entry) =>
          advanceJobFlow({
            deps: flowDeps(store, 'max3', calls) as never,
            job: entry.job,
            jobRun: entry.jobRun,
            now: '2026-08-14T20:01:00Z',
          }),
      })

      expect(calls).toHaveLength(0)
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('WARN nodeId tripwire'))
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('remote-node'))
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('max3'))
      expect(store.listJobRuns(job.jobId).jobRuns[0]?.status).toBe('succeeded')
    } finally {
      warn.mockRestore()
      store.close()
    }
  })
})
