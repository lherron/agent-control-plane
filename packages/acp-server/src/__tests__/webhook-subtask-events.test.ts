/**
 * T-09903: owner-keyed wrkq event jobs fire for the owner's named-subtask events.
 * Drives the production path: POST /v1/webhooks/wrkq → durable inbox → scheduler
 * tick with the real event-job evaluator → minted/skipped match rows.
 */
import { describe, expect, test } from 'bun:test'

import { createInMemoryAdminStore } from 'acp-admin-store'
import { type JobsStore, createInMemoryJobsStore, tickJobsScheduler } from 'acp-jobs-store'

import type { Actor } from 'acp-core'
import type { ResolvedAcpServerDeps } from '../deps.js'
import { handleWrkqWebhook } from '../handlers/webhooks-wrkq.js'
import { createEventJobEvaluator } from '../jobs/event-job-evaluator.js'

const ACTOR: Actor = { kind: 'system', id: 'test' }
const OWNER_ID = 'T-12345'
const OWNER_UUID = 'uuid-owner-12345'
const SUBTASK_ID = 'T-12345.architecture-diagram'
const SIBLING_ID = 'T-12345.test-plan'

function subtaskComment(input: {
  eventId: string
  eventSeq: number
  ticketId: string
  ownerId?: string | undefined
  ownerUuid?: string | undefined
}) {
  return {
    schema_version: 2,
    event_id: input.eventId,
    event_seq: input.eventSeq,
    event: 'comment_added',
    occurred_at: '2026-09-30T13:00:00Z',
    origin: { actor: 'human:lance', via: 'cli' },
    ticket_id: input.ticketId,
    ticket_uuid: `uuid-${input.ticketId}`,
    ...(input.ownerId !== undefined ? { subtask_owner_id: input.ownerId } : {}),
    ...(input.ownerUuid !== undefined ? { subtask_owner_uuid: input.ownerUuid } : {}),
    project_scope_id: 'demo',
    container_path: 'demo/inbox',
    kind: 'task',
    comment: { id: `C-${input.eventSeq}`, author: 'human:lance', preview: 'hello' },
  }
}

function createJob(store: JobsStore, slug: string, match: Record<string, unknown>) {
  return store.createJob({
    slug,
    agentId: 'clod',
    projectId: 'demo',
    scopeRef: 'agent:clod:project:{{project_scope_id}}:task:{{ticket_id}}',
    trigger: { kind: 'event', source: 'wrkq', match, cooldown: '5m' },
    input: { content: 'Comment on {{ticket_id}}' },
  }).job
}

async function ingest(
  deps: ResolvedAcpServerDeps,
  store: JobsStore,
  body: Record<string, unknown>,
  now: string
) {
  const request = new Request('http://acp.local/v1/webhooks/wrkq', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  const response = await handleWrkqWebhook({
    request,
    url: new URL(request.url),
    params: {},
    deps,
    actor: ACTOR,
  })
  expect(response.status).toBe(204)
  await tickJobsScheduler({
    store,
    now,
    evaluateEventJob: createEventJobEvaluator(),
    dispatchThroughInputs: async (input) => ({
      inputAttemptId: `ia_${input.jobRunId}`,
      runId: `run_${input.jobRunId}`,
    }),
  })
  const matches = store.listEventJobMatches({
    sourceEventId: `wrkq:${String(body['event_id'])}`,
  }).matches
  return new Map(matches.map((row) => [row.jobId, row]))
}

describe('wrkq subtask events reach owner-keyed event jobs (T-09903)', () => {
  test('owner trigger fires for subtask events; subtask and unrelated triggers stay scoped', async () => {
    const store = createInMemoryJobsStore()
    const deps = {
      adminStore: createInMemoryAdminStore(),
      jobsStore: store,
      defaultActor: ACTOR,
    } as unknown as ResolvedAcpServerDeps

    const byOwnerId = createJob(store, 'owner-id', { payload: { ticket_id: { eq: OWNER_ID } } })
    const byOwnerUuid = createJob(store, 'owner-uuid', {
      payload: { ticket_uuid: { eq: OWNER_UUID } },
    })
    const bySubtask = createJob(store, 'subtask', { payload: { ticket_id: { eq: SUBTASK_ID } } })
    const byOther = createJob(store, 'other-owner', { payload: { ticket_id: { eq: 'T-54321' } } })

    const first = await ingest(
      deps,
      store,
      subtaskComment({
        eventId: 'evt_sub_1',
        eventSeq: 1,
        ticketId: SUBTASK_ID,
        ownerId: OWNER_ID,
        ownerUuid: OWNER_UUID,
      }),
      '2026-09-30T13:00:00Z'
    )
    expect(first.get(byOwnerId.jobId)).toMatchObject({
      outcome: 'minted',
      targetTaskId: SUBTASK_ID,
    })
    expect(first.get(byOwnerUuid.jobId)).toMatchObject({
      outcome: 'minted',
      targetTaskId: SUBTASK_ID,
    })
    expect(first.get(bySubtask.jobId)).toMatchObject({
      outcome: 'minted',
      targetTaskId: SUBTASK_ID,
    })
    expect(first.get(byOther.jobId)?.outcome).not.toBe('minted')

    const minted = store
      .listJobRuns(byOwnerId.jobId)
      .jobRuns.find((run) => run.triggeredBy === 'webhook')
    expect(JSON.stringify(minted)).toContain(`agent:clod:project:demo:task:${SUBTASK_ID}`)

    // Cooldown keys on the resolved target (the subtask): a sibling subtask one
    // minute later still fires the owner trigger; the subtask trigger ignores it.
    const sibling = await ingest(
      deps,
      store,
      subtaskComment({
        eventId: 'evt_sub_2',
        eventSeq: 2,
        ticketId: SIBLING_ID,
        ownerId: OWNER_ID,
        ownerUuid: OWNER_UUID,
      }),
      '2026-09-30T13:01:00Z'
    )
    expect(sibling.get(byOwnerId.jobId)).toMatchObject({
      outcome: 'minted',
      targetTaskId: SIBLING_ID,
    })
    expect(sibling.get(bySubtask.jobId)?.outcome).not.toBe('minted')

    // Same subtask again inside the window: cooldown on that subtask target.
    const repeat = await ingest(
      deps,
      store,
      subtaskComment({
        eventId: 'evt_sub_3',
        eventSeq: 3,
        ticketId: SUBTASK_ID,
        ownerId: OWNER_ID,
        ownerUuid: OWNER_UUID,
      }),
      '2026-09-30T13:02:00Z'
    )
    expect(repeat.get(byOwnerId.jobId)).toMatchObject({ outcome: 'skipped', reason: 'cooldown' })

    // The owner's own event still fires the owner trigger, never the subtask one.
    const own = await ingest(
      deps,
      store,
      subtaskComment({ eventId: 'evt_own_4', eventSeq: 4, ticketId: OWNER_ID }),
      '2026-09-30T13:03:00Z'
    )
    expect(own.get(byOwnerId.jobId)).toMatchObject({ outcome: 'minted', targetTaskId: OWNER_ID })
    expect(own.get(bySubtask.jobId)?.outcome).not.toBe('minted')
  })
})
