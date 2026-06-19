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

const GUARDED_EVENT_FLOW = {
  sequence: [
    {
      id: 'create_task',
      kind: 'wrkq-task',
      title: 'Investigate {{ticket_id}}',
      container: 'agent-control-plane/inbox',
      description: 'Created from {{event}}.',
    },
    {
      id: 'dispatch',
      kind: 'agent-dispatch',
      scopeRef: 'agent:clod:project:agent-control-plane:task:primary',
      input: { content: 'Handle {{ticket_id}}.' },
    },
  ],
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

  test('creates an event-triggered job with a guarded flow', async () => {
    const { deps } = makeDeps()
    const res = await call(
      handleCreateAdminJob,
      jsonRequest('POST', '/v1/admin/jobs', {
        ...EVENT_JOB_BODY,
        flow: GUARDED_EVENT_FLOW,
      }),
      deps
    )
    expect(res.status).toBe(201)
    const body = (await res.json()) as { job: { trigger: { kind: string }; flow: unknown } }
    expect(body.job.trigger.kind).toBe('event')
    expect(body.job.flow).toEqual(GUARDED_EVENT_FLOW)
  })

  test('rejects event-triggered flow with authority interpolation', async () => {
    const { deps } = makeDeps()
    const res = await call(
      handleCreateAdminJob,
      jsonRequest('POST', '/v1/admin/jobs', {
        ...EVENT_JOB_BODY,
        flow: {
          sequence: [
            {
              id: 'dispatch',
              kind: 'agent-dispatch',
              scopeRef: 'agent:clod:project:{{payload.project}}:task:primary',
              input: { content: 'x' },
            },
          ],
        },
      }),
      deps
    )
    const body = (await res.json()) as { valid: false; errors: Array<{ code: string }> }
    expect(res.status).toBe(400)
    expect(body.errors.map((error) => error.code)).toContain('authority_field_interpolation')
  })

  test('continues rejecting output config on event-triggered flow jobs', async () => {
    const { deps } = makeDeps()
    const res = await call(
      handleCreateAdminJob,
      jsonRequest('POST', '/v1/admin/jobs', {
        ...EVENT_JOB_BODY,
        flow: GUARDED_EVENT_FLOW,
        output: {
          sinks: [
            { kind: 'webhook', url: 'http://127.0.0.1:18551/api', format: 'discord_markdown' },
          ],
        },
      }),
      deps
    )
    expect(res.status).toBe(400)
  })

  test('allows bolting a guarded flow onto an event job via patch', async () => {
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
        flow: GUARDED_EVENT_FLOW,
      }),
      deps,
      { jobId: created.jobId }
    )
    expect(res.status).toBe(200)
    const body = (await res.json()) as { job: { flow: unknown } }
    expect(body.job.flow).toEqual(GUARDED_EVENT_FLOW)
  })

  test('allows switching a guarded flow job to an event trigger via patch', async () => {
    const { jobsStore, deps } = makeDeps()
    const created = jobsStore.createJob({
      agentId: 'clod',
      projectId: 'acp',
      scopeRef: 'agent:clod:project:acp:task:primary',
      schedule: { cron: '0 * * * *' },
      input: { content: 'x' },
      flow: GUARDED_EVENT_FLOW,
    }).job
    const res = await call(
      handlePatchAdminJob,
      jsonRequest('PATCH', `/v1/admin/jobs/${created.jobId}`, {
        trigger: { kind: 'event', source: 'wrkq', match: { event: 'created' } },
      }),
      deps,
      { jobId: created.jobId }
    )
    expect(res.status).toBe(200)
    const body = (await res.json()) as { job: { trigger: { kind: string } } }
    expect(body.job.trigger.kind).toBe('event')
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
