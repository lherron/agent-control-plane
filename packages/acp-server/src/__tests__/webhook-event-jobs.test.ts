import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { call, jsonRequest, makeDeps } from '../../test/fixtures/event-job-http.js'

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
    const first = await call(jsonRequest('POST', '/v1/webhooks/wrkq', payload), deps)
    expect(first.status).toBe(204)
    expect(jobsStore.getInboxEvent('wrkq:evt_7').event).toBeDefined()

    const dup = await call(jsonRequest('POST', '/v1/webhooks/wrkq', payload), deps)
    expect(dup.status).toBe(204)
    const events = jobsStore.claimPendingInboxEvents({
      now: '2100-01-01T00:00:00.000Z',
      leaseOwner: 'test',
      leaseExpiresAt: '2101-01-01T00:00:00.000Z',
    })
    expect(events).toHaveLength(1)
  })

  test('unsupported schema_version → 400', async () => {
    const { deps } = makeDeps()
    const res = await call(
      jsonRequest('POST', '/v1/webhooks/wrkq', { ...payload, schema_version: 1 }),
      deps
    )
    expect(res.status).toBe(400)
    expect((await res.json()).error).toMatchObject({
      code: 'malformed_request',
      message: expect.stringContaining('unsupported schema_version'),
      details: { field: 'webhook' },
    })
  })

  // T-12175: wrkq delivers envelope.* and promise.* to a bare (un-narrowed)
  // subscription in their own typed shapes with no schema_version. These are
  // real bodies captured from mini wrkqd. They are not v2 task events: the
  // route stays fail-closed, writes nothing, and names the event so the log
  // says which family arrived (the fix is narrowing the subscription).
  test.each([
    ['envelope-created.json', 'envelope.created'],
    ['promise-created.json', 'promise.created'],
  ])('real wrkq %s body → 400 naming the event, no inbox row', async (file, event) => {
    const body = JSON.parse(
      readFileSync(new URL(`../../test/fixtures/wrkq-webhook/${file}`, import.meta.url), 'utf8')
    )
    expect(body.schema_version).toBeUndefined()
    const { jobsStore, deps } = makeDeps()
    const res = await call(jsonRequest('POST', '/v1/webhooks/wrkq', body), deps)
    expect(res.status).toBe(400)
    expect((await res.json()).error).toMatchObject({
      code: 'malformed_request',
      message: `unsupported schema_version: undefined (expected 2) for event ${event}`,
    })
    expect(
      jobsStore.claimPendingInboxEvents({
        now: '2100-01-01T00:00:00.000Z',
        leaseOwner: 'test',
        leaseExpiresAt: '2101-01-01T00:00:00.000Z',
      })
    ).toHaveLength(0)
  })

  // T-05270: recognized event appends exactly one lifecycle system event.
  test('recognized event appends one wrkq.* system event (observer projection)', async () => {
    const { adminStore, deps } = makeDeps()
    const res = await call(jsonRequest('POST', '/v1/webhooks/wrkq', payload), deps)
    expect(res.status).toBe(204)
    const rows = adminStore.systemEvents.list({ kind: 'wrkq.created' })
    expect(rows).toHaveLength(1)
    expect((rows[0]?.payload as Record<string, unknown>)['canonicalEventId']).toBe('wrkq:evt_7')
  })

  // Required test #4: jobsStore absent still appends the system event + 204.
  test('jobsStore absent → system event still appended, returns 204', async () => {
    const { adminStore, deps } = makeDeps({ jobsStore: false })
    const res = await call(jsonRequest('POST', '/v1/webhooks/wrkq', payload), deps)
    expect(res.status).toBe(204)
    expect(adminStore.systemEvents.list({ kind: 'wrkq.created' })).toHaveLength(1)
  })

  // Required test #5: unknown event name still ingested for the inbox but no card.
  test('unknown event name → 204, inbox row written, no lifecycle system event', async () => {
    const { adminStore, jobsStore, deps } = makeDeps()
    const res = await call(
      jsonRequest('POST', '/v1/webhooks/wrkq', {
        ...payload,
        event: 'snoozed',
        event_id: 'evt_unknown',
      }),
      deps
    )
    expect(res.status).toBe(204)
    expect(jobsStore?.getInboxEvent('wrkq:evt_unknown').event).toBeDefined()
    expect(adminStore.systemEvents.list()).toHaveLength(0)
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
    const first = await call(jsonRequest('POST', '/v1/webhooks/events', payload), deps)
    expect(first.status).toBe(204)
    const row = jobsStore.getInboxEvent('media-ingest:evt_transcript_7').event
    expect(row).toBeDefined()
    expect(row?.source).toBe('media-ingest')

    const dup = await call(jsonRequest('POST', '/v1/webhooks/events', payload), deps)
    expect(dup.status).toBe(204)
    const events = jobsStore.claimPendingInboxEvents({
      now: '2100-01-01T00:00:00.000Z',
      leaseOwner: 'test',
      leaseExpiresAt: '2101-01-01T00:00:00.000Z',
    })
    expect(events).toHaveLength(1)
  })

  test('canonical hrc rev3 payload → 204 + one durable inbox row', async () => {
    const { jobsStore, deps } = makeDeps()
    const hrcPayload = {
      schema_version: 1,
      source: 'hrc',
      event_id: 'max3:42',
      event_seq: 42,
      event: 'first_turn_missing',
      occurred_at: '2026-08-14T20:00:00Z',
      subject: { type: 'hrc-runtime', id: 'runtime-42' },
      origin: { actor: 'agent:cody', kind: 'agent', causation_ref: 'jrun-42' },
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

    const first = await call(jsonRequest('POST', '/v1/webhooks/events', hrcPayload), deps)
    expect(first.status).toBe(204)
    const row = jobsStore.getInboxEvent('hrc:max3:42').event
    expect(row).toBeDefined()
    expect(row?.source).toBe('hrc')
    expect(row?.payload).toEqual(expect.objectContaining(hrcPayload))

    const duplicate = await call(jsonRequest('POST', '/v1/webhooks/events', hrcPayload), deps)
    expect(duplicate.status).toBe(204)
    const events = jobsStore.claimPendingInboxEvents({
      now: '2100-01-01T00:00:00.000Z',
      leaseOwner: 'test',
      leaseExpiresAt: '2101-01-01T00:00:00.000Z',
    })
    expect(events).toHaveLength(1)

    const { schema_version: _schemaVersion, ...missingSchema } = hrcPayload
    const rejected = await call(jsonRequest('POST', '/v1/webhooks/events', missingSchema), deps)
    expect(rejected.status).toBe(400)
    expect((await rejected.json()).error).toMatchObject({
      code: 'malformed_request',
      message: expect.stringContaining('unsupported schema_version'),
      details: { field: 'webhook' },
    })
  })

  test('same local HRC trip sequence from two nodes produces two inbox rows', async () => {
    const { jobsStore, deps } = makeDeps()
    const envelope = (nodeId: string, runtimeId: string) => ({
      schema_version: 1,
      source: 'hrc',
      event_id: `${nodeId}:42`,
      event_seq: 42,
      event: 'first_turn_missing',
      occurred_at: '2026-08-14T20:00:00Z',
      subject: { type: 'hrc-runtime', id: runtimeId },
      origin: { actor: 'system:hrc', kind: 'system' },
      payload: {
        nodeId,
        runtimeId,
        scopeRef: 'agent:cody:project:agent-control-plane:task:T-07237',
        generation: 3,
        invocationId: `invocation-${nodeId}`,
        runId: `run-${nodeId}`,
        tripEventId: '42',
        retrievalHint: 'hrc runtime diagnostics 42',
      },
    })

    const max3 = await call(
      jsonRequest('POST', '/v1/webhooks/events', envelope('max3', 'runtime-max3')),
      deps
    )
    const svc = await call(
      jsonRequest('POST', '/v1/webhooks/events', envelope('svc', 'runtime-svc')),
      deps
    )

    expect(max3.status).toBe(204)
    expect(svc.status).toBe(204)
    expect(jobsStore.getInboxEvent('hrc:max3:42').event).toBeDefined()
    expect(jobsStore.getInboxEvent('hrc:svc:42').event).toBeDefined()
    const events = jobsStore.claimPendingInboxEvents({
      now: '2100-01-01T00:00:00.000Z',
      leaseOwner: 'test',
      leaseExpiresAt: '2101-01-01T00:00:00.000Z',
    })
    expect(events).toHaveLength(2)
  })

  test('invalid generic envelope → 400', async () => {
    const { deps } = makeDeps()
    const res = await call(
      jsonRequest('POST', '/v1/webhooks/events', { ...payload, source: 'Media Ingest' }),
      deps
    )
    expect(res.status).toBe(400)
    expect((await res.json()).error).toMatchObject({
      code: 'malformed_request',
      message: expect.stringContaining('source must match'),
      details: { field: 'webhook' },
    })
  })
})
