import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { type InterfaceStore, openInterfaceStore } from 'acp-interface-store'
import { createInMemoryJobsStore, fingerprintJobOutputSink } from 'acp-jobs-store'

import { InMemoryRunStore } from '../domain/run-store.js'
import { createJobOutputReconciler } from './output-reconciler.js'

const fixtureDirs: string[] = []

afterEach(() => {
  while (fixtureDirs.length > 0) {
    const dir = fixtureDirs.pop()
    if (dir !== undefined) {
      rmSync(dir, { recursive: true, force: true })
    }
  }
})

function makeInterfaceStore(): InterfaceStore {
  const dir = mkdtempSync(join(tmpdir(), 'acp-output-reconciler-'))
  fixtureDirs.push(dir)
  return openInterfaceStore({ dbPath: join(dir, 'interface.sqlite') })
}

function enqueueDelivery(
  interfaceStore: InterfaceStore,
  input: { runId: string; deliveryRequestId: string; bodyText: string; createdAt: string }
) {
  return interfaceStore.deliveries.enqueue({
    deliveryRequestId: input.deliveryRequestId,
    gatewayId: 'discord_prod',
    bindingId: 'ifb_media',
    scopeRef: 'agent:mneme:project:media-ingest:task:primary',
    laneRef: 'main',
    runId: input.runId,
    conversationRef: 'channel:123',
    bodyKind: 'text/markdown',
    bodyText: input.bodyText,
    createdAt: input.createdAt,
  })
}

function createCompletedRun(runStore: InMemoryRunStore) {
  return runStore.createRun({
    sessionRef: {
      scopeRef: 'agent:mneme:project:media-ingest:task:primary',
      laneRef: 'main' as const,
    },
    status: 'completed',
  })
}

describe('job output reconciler', () => {
  test('posts final delivery body text, records success, and is idempotent after config change', async () => {
    const jobsStore = createInMemoryJobsStore()
    const runStore = new InMemoryRunStore()
    const interfaceStore = makeInterfaceStore()
    jobsStore.insertInboxEvent({
      eventId: 'evt_transcript_1',
      eventSeq: 1,
      source: 'media-ingest',
      event: 'transcript.completed',
      payload: {
        schema_version: 1,
        source: 'media-ingest',
        event_id: 'evt_transcript_1',
        canonical_event_id: 'media-ingest:evt_transcript_1',
        event_seq: 1,
        event: 'transcript.completed',
        payload: { transcript_id: 'tr_1', episode_id: 'ep_1', feed_id: 'feed_1' },
      },
    })
    const job = jobsStore.createJob({
      slug: 'media-ingest-transcript-summary-discord',
      projectId: 'media-ingest',
      agentId: 'mneme',
      scopeRef: 'agent:mneme:project:media-ingest:task:primary',
      trigger: { kind: 'event', source: 'media-ingest', match: { event: 'transcript.completed' } },
      input: { content: 'summarize' },
      output: {
        sinks: [{ kind: 'webhook', url: 'http://127.0.0.1:18551/api/transcript-summaries' }],
      },
    }).job
    const run = createCompletedRun(runStore)
    const jobRun = jobsStore.createJobRun(job.jobId, {
      triggeredAt: '2026-06-18T10:00:00.000Z',
      triggeredBy: 'webhook',
      status: 'dispatched',
      inputAttemptId: 'ia_1',
      runId: run.runId,
      source: {
        kind: 'webhook',
        source: 'media-ingest',
        eventId: 'evt_transcript_1',
        canonicalEventId: 'media-ingest:evt_transcript_1',
      },
    }).jobRun
    jobsStore.updateJob(job.jobId, {
      output: { sinks: [{ kind: 'webhook', url: 'http://127.0.0.1:19999/changed' }] },
    })

    enqueueDelivery(interfaceStore, {
      runId: run.runId,
      deliveryRequestId: `dr_${run.runId}_oob_0001`,
      bodyText: 'ignore me',
      createdAt: '2026-06-18T10:01:00.000Z',
    })
    enqueueDelivery(interfaceStore, {
      runId: run.runId,
      deliveryRequestId: `dr_${run.runId}_dispatch_0001`,
      bodyText: '**Episode**\n- final visible text',
      createdAt: '2026-06-18T10:02:00.000Z',
    })

    const calls: Array<{ request: Request; init?: RequestInit | undefined }> = []
    const reconciler = createJobOutputReconciler({
      jobsStore,
      runStore,
      interfaceStore,
      now: () => new Date('2026-06-18T10:03:00.000Z'),
      fetch: async (request, init) => {
        calls.push({ request: request instanceof Request ? request : new Request(request), init })
        return new Response('', { status: 204 })
      },
    })

    await reconciler.runOnce()
    await reconciler.runOnce()

    expect(calls).toHaveLength(1)
    expect(calls[0]?.request.url).toBe('http://127.0.0.1:18551/api/transcript-summaries')
    expect((calls[0]?.init?.headers as Record<string, string>)['idempotency-key']).toBe(
      `acp-job-output:${jobRun.jobRunId}:0`
    )
    const payload = JSON.parse(String(calls[0]?.init?.body)) as Record<string, unknown>
    expect(payload['job_slug']).toBe('media-ingest-transcript-summary-discord')
    expect(payload['delivery_request_id']).toBe(`dr_${run.runId}_dispatch_0001`)
    expect((payload['output'] as Record<string, unknown>)['text']).toBe(
      '**Episode**\n- final visible text'
    )
    expect((payload['payload'] as Record<string, unknown>)['transcript_id']).toBe('tr_1')
    expect(jobsStore.getJobRun(jobRun.jobRunId).jobRun?.status).toBe('succeeded')
    expect(jobsStore.listJobOutputSinkAttempts(jobRun.jobRunId).attempts).toHaveLength(1)
    interfaceStore.close()
  })

  test('failed ACP run marks job run failed without posting', async () => {
    const jobsStore = createInMemoryJobsStore()
    const runStore = new InMemoryRunStore()
    const interfaceStore = makeInterfaceStore()
    const job = jobsStore.createJob({
      projectId: 'media-ingest',
      agentId: 'mneme',
      scopeRef: 'agent:mneme:project:media-ingest:task:primary',
      trigger: { kind: 'event', source: 'media-ingest', match: { event: 'transcript.completed' } },
      input: { content: 'summarize' },
      output: { sinks: [{ kind: 'webhook', url: 'http://localhost:18551/api' }] },
    }).job
    const run = runStore.createRun({
      sessionRef: {
        scopeRef: 'agent:mneme:project:media-ingest:task:primary',
        laneRef: 'main' as const,
      },
      status: 'failed',
    })
    const jobRun = jobsStore.createJobRun(job.jobId, {
      triggeredAt: '2026-06-18T10:00:00.000Z',
      triggeredBy: 'webhook',
      status: 'dispatched',
      runId: run.runId,
    }).jobRun
    const reconciler = createJobOutputReconciler({
      jobsStore,
      runStore,
      interfaceStore,
      fetch: async () => {
        throw new Error('unexpected fetch')
      },
    })

    await reconciler.runOnce()

    expect(jobsStore.getJobRun(jobRun.jobRunId).jobRun).toMatchObject({
      status: 'failed',
      errorCode: 'run_failed',
    })
    interfaceStore.close()
  })

  describe('bounded delivery policy (T-10005)', () => {
    const SINK_URL = 'http://127.0.0.1:18551/api/transcript-summaries'

    function setup(input: { output?: Record<string, unknown> | undefined } = {}) {
      const jobsStore = createInMemoryJobsStore()
      const runStore = new InMemoryRunStore()
      const interfaceStore = makeInterfaceStore()
      const output = (input.output ?? {
        sinks: [{ kind: 'webhook', url: SINK_URL }],
      }) as Parameters<typeof jobsStore.createJob>[0]['output']
      const job = jobsStore.createJob({
        slug: 'dead-sink-job',
        projectId: 'media-ingest',
        agentId: 'mneme',
        scopeRef: 'agent:mneme:project:media-ingest:task:primary',
        trigger: {
          kind: 'event',
          source: 'media-ingest',
          match: { event: 'transcript.completed' },
        },
        input: { content: 'summarize' },
        output,
      }).job
      const run = createCompletedRun(runStore)
      const jobRun = jobsStore.createJobRun(job.jobId, {
        triggeredAt: '2026-06-18T10:00:00.000Z',
        triggeredBy: 'webhook',
        status: 'dispatched',
        runId: run.runId,
      }).jobRun
      enqueueDelivery(interfaceStore, {
        runId: run.runId,
        deliveryRequestId: `dr_${run.runId}_dispatch_0001`,
        bodyText: 'summary text',
        createdAt: '2026-06-18T10:01:00.000Z',
      })
      return { jobsStore, runStore, interfaceStore, job, jobRun }
    }

    function refusingFetch(calls: string[]): typeof fetch {
      return (async (request: string | URL | Request) => {
        calls.push(String(request instanceof Request ? request.url : request))
        throw new Error('connect ECONNREFUSED 127.0.0.1:18551')
      }) as typeof fetch
    }

    test('settles failed output_delivery_exhausted once the attempt cap is reached', async () => {
      const { jobsStore, runStore, interfaceStore, jobRun } = setup()
      const settled: string[] = []
      let clock = Date.parse('2026-06-18T10:02:00.000Z')
      const calls: string[] = []
      const reconciler = createJobOutputReconciler({
        jobsStore,
        runStore,
        interfaceStore,
        now: () => new Date(clock),
        fetch: refusingFetch(calls),
        delivery: { maxAttempts: 3, maxAgeSeconds: 86_400 },
        onJobRunSettled: (run) => settled.push(`${run.status}:${run.errorCode}`),
      })

      for (let pass = 0; pass < 6; pass += 1) {
        await reconciler.runOnce()
        clock += 20 * 60_000
      }

      expect(calls).toHaveLength(3)
      const final = jobsStore.getJobRun(jobRun.jobRunId).jobRun
      expect(final).toMatchObject({ status: 'failed', errorCode: 'output_delivery_exhausted' })
      expect(final?.errorMessage).toContain('3 attempts')
      expect(final?.errorMessage).toContain('ECONNREFUSED')
      expect(final?.errorMessage).toContain(SINK_URL)
      expect(settled).toEqual(['failed:output_delivery_exhausted'])
      interfaceStore.close()
    })

    test('settles on the age cap even when the attempt cap is not reached', async () => {
      const { jobsStore, runStore, interfaceStore, jobRun } = setup()
      let clock = Date.parse('2026-06-18T10:02:00.000Z')
      const calls: string[] = []
      const reconciler = createJobOutputReconciler({
        jobsStore,
        runStore,
        interfaceStore,
        now: () => new Date(clock),
        fetch: refusingFetch(calls),
        delivery: { maxAttempts: 100, maxAgeSeconds: 3_600 },
      })

      await reconciler.runOnce()
      clock += 2 * 3_600_000
      await reconciler.runOnce()

      expect(calls).toHaveLength(1)
      expect(jobsStore.getJobRun(jobRun.jobRunId).jobRun).toMatchObject({
        status: 'failed',
        errorCode: 'output_delivery_exhausted',
      })
      interfaceStore.close()
    })

    test('a run already over the default cap settles without another POST', async () => {
      const { jobsStore, runStore, interfaceStore, jobRun } = setup()
      for (let attempt = 0; attempt < 30; attempt += 1) {
        jobsStore.recordJobOutputSinkAttempt({
          jobRunId: jobRun.jobRunId,
          sinkIndex: 0,
          sinkFingerprint: fingerprintJobOutputSink({ kind: 'webhook', url: SINK_URL }),
          status: 'failed',
          attemptedAt: '2026-06-18T10:02:00.000Z',
          nextAttemptAt: '2026-06-18T10:03:00.000Z',
          lastError: 'connect ECONNREFUSED',
        })
      }
      const calls: string[] = []
      const reconciler = createJobOutputReconciler({
        jobsStore,
        runStore,
        interfaceStore,
        now: () => new Date('2026-06-18T10:10:00.000Z'),
        fetch: refusingFetch(calls),
      })

      await reconciler.runOnce()

      expect(calls).toHaveLength(0)
      const final = jobsStore.getJobRun(jobRun.jobRunId).jobRun
      expect(final).toMatchObject({ status: 'failed', errorCode: 'output_delivery_exhausted' })
      expect(final?.errorMessage).toContain('30 attempts')
      interfaceStore.close()
    })

    test('per-job output.delivery overrides the global default', async () => {
      const { jobsStore, runStore, interfaceStore, jobRun } = setup({
        output: { sinks: [{ kind: 'webhook', url: SINK_URL }], delivery: { maxAttempts: 1 } },
      })
      const calls: string[] = []
      const reconciler = createJobOutputReconciler({
        jobsStore,
        runStore,
        interfaceStore,
        now: () => new Date('2026-06-18T10:02:00.000Z'),
        fetch: refusingFetch(calls),
      })

      await reconciler.runOnce()

      expect(calls).toHaveLength(1)
      expect(jobsStore.getJobRun(jobRun.jobRunId).jobRun).toMatchObject({
        status: 'failed',
        errorCode: 'output_delivery_exhausted',
      })
      interfaceStore.close()
    })

    test('default policy keeps retrying a fresh failure and still delivers when the sink recovers', async () => {
      const { jobsStore, runStore, interfaceStore, jobRun } = setup()
      let clock = Date.parse('2026-06-18T10:02:00.000Z')
      let healthy = false
      const reconciler = createJobOutputReconciler({
        jobsStore,
        runStore,
        interfaceStore,
        now: () => new Date(clock),
        fetch: (async () => {
          if (!healthy) {
            return new Response('down', { status: 503 })
          }
          return new Response('', { status: 201 })
        }) as unknown as typeof fetch,
      })

      await reconciler.runOnce()
      expect(jobsStore.getJobRun(jobRun.jobRunId).jobRun?.status).toBe('dispatched')
      healthy = true
      clock += 20 * 60_000
      await reconciler.runOnce()

      expect(jobsStore.getJobRun(jobRun.jobRunId).jobRun?.status).toBe('succeeded')
      interfaceStore.close()
    })

    test('an invalid (non-loopback) sink settles failed at once with output_sink_invalid', async () => {
      const { jobsStore, runStore, interfaceStore, jobRun } = setup({
        output: { sinks: [{ kind: 'webhook', url: 'https://example.com/hook' }] },
      })
      const calls: string[] = []
      const reconciler = createJobOutputReconciler({
        jobsStore,
        runStore,
        interfaceStore,
        now: () => new Date('2026-06-18T10:02:00.000Z'),
        fetch: refusingFetch(calls),
      })

      await reconciler.runOnce()

      expect(calls).toHaveLength(0)
      expect(jobsStore.getJobRun(jobRun.jobRunId).jobRun).toMatchObject({
        status: 'failed',
        errorCode: 'output_sink_invalid',
      })
      interfaceStore.close()
    })

    test('an oversized payload settles failed at once with output_payload_too_large', async () => {
      const { jobsStore, runStore, interfaceStore, jobRun } = setup()
      const calls: string[] = []
      const reconciler = createJobOutputReconciler({
        jobsStore,
        runStore,
        interfaceStore,
        now: () => new Date('2026-06-18T10:02:00.000Z'),
        fetch: refusingFetch(calls),
        maxPayloadBytes: 10,
      })

      await reconciler.runOnce()

      expect(calls).toHaveLength(0)
      expect(jobsStore.getJobRun(jobRun.jobRunId).jobRun).toMatchObject({
        status: 'failed',
        errorCode: 'output_payload_too_large',
      })
      interfaceStore.close()
    })
  })
})
