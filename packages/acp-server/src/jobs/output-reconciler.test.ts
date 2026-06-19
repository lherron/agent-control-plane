import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { type InterfaceStore, openInterfaceStore } from 'acp-interface-store'
import { createInMemoryJobsStore } from 'acp-jobs-store'

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
})
