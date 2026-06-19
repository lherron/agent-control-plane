import { describe, expect, test } from 'bun:test'

import { createInMemoryJobsStore } from 'acp-jobs-store'

import type { Actor } from 'acp-core'
import type { ResolvedAcpServerDeps } from '../deps.js'
import { handleCreateAdminJob, handlePatchAdminJob } from '../handlers/admin-jobs.js'
import { handleAcpEventWebhook } from '../handlers/webhooks-events.js'
import { handleWrkqWebhook } from '../handlers/webhooks-wrkq.js'
import { errorResponse } from '../http.js'

const ACTOR: Actor = { kind: 'system', id: 'test' }

function makeDeps() {
  const jobsStore = createInMemoryJobsStore()
  const deps = { jobsStore, defaultActor: ACTOR } as unknown as ResolvedAcpServerDeps
  return { jobsStore, deps }
}

function jsonRequest(method: string, path: string, body: unknown): Request {
  return new Request(`http://acp.local${path}`, {
    method,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
}

async function call(
  handler: (ctx: {
    request: Request
    url: URL
    params: Record<string, string>
    deps: ResolvedAcpServerDeps
    actor: Actor | undefined
  }) => Response | Promise<Response>,
  request: Request,
  deps: ResolvedAcpServerDeps,
  params: Record<string, string> = {}
): Promise<Response> {
  try {
    return await handler({ request, url: new URL(request.url), params, deps, actor: ACTOR })
  } catch (error) {
    return errorResponse(error)
  }
}

const EVENT_JOB_BODY = {
  agentId: 'clod',
  projectId: 'acp',
  scopeRef: 'agent:clod:project:{{project_scope_id}}:task:{{ticket_id}}',
  trigger: {
    kind: 'event',
    source: 'wrkq',
    match: { event: 'created', transition: { to: 'idea' } },
  },
  input: { content: 'Research {{ticket_id}}' },
}

describe('admin jobs trigger union', () => {
  test('creates an event-triggered job', async () => {
    const { deps } = makeDeps()
    const res = await call(
      handleCreateAdminJob,
      jsonRequest('POST', '/v1/admin/jobs', EVENT_JOB_BODY),
      deps
    )
    expect(res.status).toBe(201)
    const body = (await res.json()) as { job: { trigger: { kind: string } } }
    expect(body.job.trigger.kind).toBe('event')
  })

  test('creates a non-flow event job with output webhook config', async () => {
    const { deps } = makeDeps()
    const res = await call(
      handleCreateAdminJob,
      jsonRequest('POST', '/v1/admin/jobs', {
        ...EVENT_JOB_BODY,
        output: {
          sinks: [
            { kind: 'webhook', url: 'http://127.0.0.1:18551/api', format: 'discord_markdown' },
          ],
        },
      }),
      deps
    )
    expect(res.status).toBe(201)
    const body = (await res.json()) as { job: { output?: { sinks?: Array<{ url: string }> } } }
    expect(body.job.output?.sinks?.[0]?.url).toBe('http://127.0.0.1:18551/api')
  })

  test('rejects non-loopback output webhook URLs', async () => {
    const { deps } = makeDeps()
    const res = await call(
      handleCreateAdminJob,
      jsonRequest('POST', '/v1/admin/jobs', {
        ...EVENT_JOB_BODY,
        output: { sinks: [{ kind: 'webhook', url: 'https://example.com/hook' }] },
      }),
      deps
    )
    expect(res.status).toBe(400)
  })

  test('rejects event + flow on create (check #6)', async () => {
    const { deps } = makeDeps()
    const res = await call(
      handleCreateAdminJob,
      jsonRequest('POST', '/v1/admin/jobs', {
        ...EVENT_JOB_BODY,
        flow: { sequence: [{ id: 'step-1', input: 'do it' }] },
      }),
      deps
    )
    expect(res.status).toBe(400)
  })

  test('rejects bolting a flow onto an event job via patch (check #6)', async () => {
    const { jobsStore, deps } = makeDeps()
    const created = jobsStore.createJob({
      agentId: 'clod',
      projectId: 'acp',
      scopeRef: 'agent:clod:project:{{project_scope_id}}:task:{{ticket_id}}',
      trigger: { kind: 'event', source: 'wrkq', match: { event: 'created' } },
      input: { content: 'x' },
    }).job
    const res = await call(
      handlePatchAdminJob,
      jsonRequest('PATCH', `/v1/admin/jobs/${created.jobId}`, {
        flow: { sequence: [{ id: 'step-1', input: 'do it' }] },
      }),
      deps,
      { jobId: created.jobId }
    )
    expect(res.status).toBe(400)
  })

  test('rejects switching a flow job to an event trigger via patch', async () => {
    const { jobsStore, deps } = makeDeps()
    const created = jobsStore.createJob({
      agentId: 'clod',
      projectId: 'acp',
      scopeRef: 'agent:clod:project:acp:task:primary',
      schedule: { cron: '0 * * * *' },
      input: { content: 'x' },
      flow: { sequence: [{ id: 'step-1', input: 'do it' }] },
    }).job
    const res = await call(
      handlePatchAdminJob,
      jsonRequest('PATCH', `/v1/admin/jobs/${created.jobId}`, {
        trigger: { kind: 'event', source: 'wrkq', match: { event: 'created' } },
      }),
      deps,
      { jobId: created.jobId }
    )
    expect(res.status).toBe(400)
  })

  test('rejects an invalid trigger', async () => {
    const { deps } = makeDeps()
    const res = await call(
      handleCreateAdminJob,
      jsonRequest('POST', '/v1/admin/jobs', {
        ...EVENT_JOB_BODY,
        trigger: { kind: 'event', source: 'Bad Source', match: {} },
      }),
      deps
    )
    expect(res.status).toBe(400)
  })
})

describe('POST /v1/webhooks/wrkq', () => {
  const payload = {
    schema_version: 2,
    event_id: 'evt_7',
    event_seq: 7,
    event: 'created',
    occurred_at: '2026-06-07T00:00:00Z',
    origin: { actor: 'human:lance' },
    ticket_id: 'T-1',
    project_scope_id: 'acp',
    transition: { from: null, to: 'idea' },
  }

  test('valid v2 payload → 204 + one durable inbox row; duplicate → 204, no second row', async () => {
    const { jobsStore, deps } = makeDeps()
    const first = await call(
      handleWrkqWebhook,
      jsonRequest('POST', '/v1/webhooks/wrkq', payload),
      deps
    )
    expect(first.status).toBe(204)
    expect(jobsStore.getInboxEvent('wrkq:evt_7').event).toBeDefined()

    const dup = await call(
      handleWrkqWebhook,
      jsonRequest('POST', '/v1/webhooks/wrkq', payload),
      deps
    )
    expect(dup.status).toBe(204)
    const count = jobsStore.sqlite.prepare('SELECT COUNT(*) AS c FROM event_inbox').get() as {
      c: number
    }
    expect(count.c).toBe(1)
  })

  test('unsupported schema_version → 400', async () => {
    const { deps } = makeDeps()
    const res = await call(
      handleWrkqWebhook,
      jsonRequest('POST', '/v1/webhooks/wrkq', { ...payload, schema_version: 1 }),
      deps
    )
    expect(res.status).toBe(400)
  })
})

describe('POST /v1/webhooks/events', () => {
  const payload = {
    schema_version: 1,
    source: 'media-ingest',
    event_id: 'evt_transcript_7',
    event_seq: 7,
    event: 'transcript.completed',
    occurred_at: '2026-06-13T00:00:00Z',
    origin: { actor: 'system:media-ingest', kind: 'system' },
    subject: { type: 'transcript', id: 'tr_7' },
    payload: { transcript_id: 'tr_7', backend: 'mlx' },
  }

  test('valid v1 payload → 204 + source-qualified inbox row; duplicate remains 204', async () => {
    const { jobsStore, deps } = makeDeps()
    const first = await call(
      handleAcpEventWebhook,
      jsonRequest('POST', '/v1/webhooks/events', payload),
      deps
    )
    expect(first.status).toBe(204)
    const row = jobsStore.getInboxEvent('media-ingest:evt_transcript_7').event
    expect(row).toBeDefined()
    expect(row?.source).toBe('media-ingest')

    const dup = await call(
      handleAcpEventWebhook,
      jsonRequest('POST', '/v1/webhooks/events', payload),
      deps
    )
    expect(dup.status).toBe(204)
    const count = jobsStore.sqlite.prepare('SELECT COUNT(*) AS c FROM event_inbox').get() as {
      c: number
    }
    expect(count.c).toBe(1)
  })

  test('invalid generic envelope → 400', async () => {
    const { deps } = makeDeps()
    const res = await call(
      handleAcpEventWebhook,
      jsonRequest('POST', '/v1/webhooks/events', { ...payload, source: 'Media Ingest' }),
      deps
    )
    expect(res.status).toBe(400)
  })
})
