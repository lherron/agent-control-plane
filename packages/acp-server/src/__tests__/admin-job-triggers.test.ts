import { describe, expect, test } from 'bun:test'
import { call, jsonRequest, makeDeps } from '../../test/fixtures/event-job-http.js'

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
    const res = await call(jsonRequest('POST', '/v1/admin/jobs', EVENT_JOB_BODY), deps)
    expect(res.status).toBe(201)
    const body = (await res.json()) as { job: { trigger: { kind: string } } }
    expect(body.job.trigger.kind).toBe('event')
  })

  test('creates a non-flow event job with output webhook config', async () => {
    const { deps } = makeDeps()
    const res = await call(
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
      jsonRequest('POST', '/v1/admin/jobs', {
        ...EVENT_JOB_BODY,
        output: { sinks: [{ kind: 'webhook', url: 'https://example.com/hook' }] },
      }),
      deps
    )
    expect(res.status).toBe(400)
    expect((await res.json()).error).toMatchObject({
      code: 'malformed_request',
      message: expect.stringContaining('must be loopback'),
      details: { field: 'output' },
    })
  })

  test('creates an event-triggered job with a guarded flow', async () => {
    const { deps } = makeDeps()
    const res = await call(
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
    expect((await res.json()).error).toMatchObject({
      code: 'malformed_request',
      message: expect.stringContaining('only supported for non-flow'),
      details: { field: 'output' },
    })
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
      jsonRequest('PATCH', `/v1/admin/jobs/${created.jobId}`, {
        flow: GUARDED_EVENT_FLOW,
      }),
      deps
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
      trigger: { kind: 'event', source: 'wrkq', match: { event: 'created' } },
      input: { content: 'x' },
      flow: GUARDED_EVENT_FLOW,
    }).job
    const res = await call(
      jsonRequest('PATCH', `/v1/admin/jobs/${created.jobId}`, {
        trigger: { kind: 'event', source: 'wrkq', match: { event: 'created' } },
      }),
      deps
    )
    expect(res.status).toBe(200)
    const body = (await res.json()) as { job: { trigger: { kind: string } } }
    expect(body.job.trigger.kind).toBe('event')
  })

  test('rejects an invalid trigger', async () => {
    const { deps } = makeDeps()
    const res = await call(
      jsonRequest('POST', '/v1/admin/jobs', {
        ...EVENT_JOB_BODY,
        trigger: { kind: 'event', source: 'Bad Source', match: {} },
      }),
      deps
    )
    expect(res.status).toBe(400)
    expect((await res.json()).error).toMatchObject({
      code: 'malformed_request',
      message: expect.stringContaining('trigger.source'),
      details: { field: 'trigger' },
    })
  })
})
