import { describe, expect, test } from 'bun:test'

import type { HrcLifecycleEvent, HrcSessionRecord } from 'hrc-core'

import {
  type AcpHrcClient,
  InMemoryInputAdmissionStore,
  InMemoryInputQueueStore,
  InMemoryRunStore,
} from '../src/index.js'
import {
  expireInputOnGenerationBump,
  reconcileQueuedInputContexts,
} from '../src/input-admission/expire-queued-input.js'
import { type SeatRestartCall, SeatRestartRefusal } from '../src/seat-restart-client.js'
import { withWiredServer } from './fixtures/wired-server.js'

const NOW = '2026-10-14T12:00:00.000Z'
const SCOPE = 'agent:clod:project:hrc-ios:task:T-10850'
const PRIOR = 'hsid-prior'
const SUCCESSOR = 'hsid-successor'

const SESSION: HrcSessionRecord = {
  hostSessionId: PRIOR,
  scopeRef: SCOPE,
  laneRef: 'main',
  generation: 3,
  status: 'active',
  createdAt: NOW,
  updatedAt: NOW,
}

type RestartCall = { op: string; args: Record<string, unknown> }

function makeHrcClient(): AcpHrcClient {
  return { getSession: async () => SESSION } as unknown as AcpHrcClient
}

function seatRestartCall(calls: RestartCall[], refusal?: SeatRestartRefusal): SeatRestartCall {
  return async (op, args) => {
    calls.push({ op, args })
    if (refusal !== undefined) throw refusal
    return {
      outcome: 'restarted',
      scopeRef: SCOPE,
      sessionRef: `${SCOPE}/lane:main`,
      priorHostSessionId: PRIOR,
      hostSessionId: SUCCESSOR,
      generation: 4,
      launch: { status: 'started', runtimeId: 'rt-successor' },
    }
  }
}

type Stores = {
  inputQueueStore: InMemoryInputQueueStore
  runStore: InMemoryRunStore
  inputAdmissionStore: InMemoryInputAdmissionStore
}

function stores(): Stores {
  return {
    inputQueueStore: new InMemoryInputQueueStore(),
    runStore: new InMemoryRunStore(),
    inputAdmissionStore: new InMemoryInputAdmissionStore(),
  }
}

/** One queued input as admission writes it: run, admission and queue item together. */
function enqueue(
  s: Stores,
  name: string,
  seq: number,
  fence: { hostSessionId: string; generation: number } | undefined,
  resetPolicy: 'expire_on_generation_change' | 'follow_latest' = 'expire_on_generation_change'
) {
  const run = s.runStore.createRun({ sessionRef: { scopeRef: SCOPE, laneRef: 'main' } })
  s.inputAdmissionStore.create({
    inputAttemptId: `attempt-${name}`,
    admissionKind: 'queued',
    intent: { kind: 'new_work' },
    originalResponse: {},
    runId: run.runId,
    status: 'queued',
  })
  return s.inputQueueStore.create({
    inputAttemptId: `attempt-${name}`,
    runId: run.runId,
    scopeRef: SCOPE,
    laneRef: 'main',
    seq,
    resetPolicy,
    ...(fence
      ? { expectedHostSessionId: fence.hostSessionId, expectedGeneration: fence.generation }
      : {}),
  })
}

/** Queued input: fenced to the prior generation, unfenced, fenced to the successor, follow_latest. */
function seedQueue(s: Stores) {
  return {
    prior: enqueue(s, 'prior', 1, { hostSessionId: PRIOR, generation: 3 }),
    unfenced: enqueue(s, 'loose', 2, undefined),
    successor: enqueue(s, 'successor', 3, { hostSessionId: SUCCESSOR, generation: 4 }),
    followLatest: enqueue(s, 'follow', 4, undefined, 'follow_latest'),
  }
}

async function restart(
  call: SeatRestartCall,
  s: Stores,
  body: Record<string, unknown>
): Promise<{ status: number; body: Record<string, unknown> }> {
  return await withWiredServer(
    async ({ request, json }) => {
      const response = await request({
        method: 'POST',
        path: `/v1/mobile/sessions/${PRIOR}/restart`,
        body,
      })
      return { status: response.status, body: await json<Record<string, unknown>>(response) }
    },
    { hrcClient: makeHrcClient(), seatRestartCall: call, ...s }
  )
}

describe('POST /v1/mobile/sessions/:hostSessionId/restart', () => {
  test('passes both phone fences to cold restart', async () => {
    const calls: RestartCall[] = []
    const store = stores()
    const items = seedQueue(store)

    const result = await restart(seatRestartCall(calls), store, {
      fences: { expectedGeneration: 3 },
    })

    expect(result.status).toBe(200)
    expect(result.body).toEqual({
      ok: true,
      priorHostSessionId: PRIOR,
      hostSessionId: SUCCESSOR,
      generation: 4,
      launch: { status: 'started', runtimeId: 'rt-successor' },
    })
    expect(calls).toEqual([
      {
        op: 'seat-restart.cold',
        args: {
          seat: `${SCOPE}/lane:main`,
          idempotencyKey: expect.any(String),
          when: 'now',
          expectedHostSessionId: PRIOR,
          expectedGeneration: 3,
        },
      },
    ])
    for (const item of Object.values(items)) {
      expect(store.inputQueueStore.getById(item.queueItemId)?.status).toBe('queued')
    }
  })

  test.each(['event', 'reconcile'])(
    'expires old input on generation observation via %s',
    async (source) => {
      const store = stores()
      const items = seedQueue(store)
      const bump = new Date(Date.now() + 1000).toISOString()
      const head = { ...SESSION, hostSessionId: SUCCESSOR, generation: 4, createdAt: bump }
      if (source === 'event') {
        expireInputOnGenerationBump(store, {
          ...head,
          laneRef: 'lane:main',
          ts: bump,
          eventKind: 'session.created',
        } as HrcLifecycleEvent)
      } else {
        const hrc = {
          resolveSession: async () => ({ found: true, session: head }),
        } as unknown as AcpHrcClient
        await reconcileQueuedInputContexts(store, hrc, new AbortController().signal)
      }
      expect(store.inputQueueStore.getById(items.prior.queueItemId)?.status).toBe('expired')
      expect(store.inputQueueStore.getById(items.unfenced.queueItemId)?.status).toBe('expired')
      expect(store.inputQueueStore.getById(items.successor.queueItemId)?.status).toBe('queued')
      expect(store.inputQueueStore.getById(items.followLatest.queueItemId)?.status).toBe('queued')
    }
  )

  for (const [hrcCode, mobileCode, status] of [
    ['runtime_busy', 'session_busy', 409],
    ['seat_unobservable', 'seat_unobservable', 409],
    ['stale_context', 'stale_context', 409],
    ['missing_runtime_intent', 'not_restartable', 422],
  ] as const) {
    test(`maps HRC ${hrcCode} to ${mobileCode} and changes nothing`, async () => {
      const calls: RestartCall[] = []
      const store = stores()
      const items = seedQueue(store)
      const detail = { activeHostSessionId: SUCCESSOR, activeGeneration: 4 }

      const result = await restart(
        seatRestartCall(calls, new SeatRestartRefusal(hrcCode, `refused: ${hrcCode}`, detail)),
        store,
        { fences: { expectedGeneration: 3 } }
      )

      expect(result.status).toBe(status)
      expect(result.body['ok']).toBe(false)
      expect(result.body['code']).toBe(mobileCode)
      expect(result.body['detail']).toEqual(detail)
      for (const item of Object.values(items)) {
        expect(store.inputQueueStore.getById(item.queueItemId)?.status).toBe('queued')
      }
    })
  }

  test('maps a participant refusal to not_restartable', async () => {
    const result = await restart(
      seatRestartCall(
        [],
        new SeatRestartRefusal('runtime_unavailable', 'participant', {
          reason: 'participant_rotation_unsupported',
        })
      ),
      stores(),
      { fences: { expectedGeneration: 3 } }
    )

    expect(result.status).toBe(422)
    expect(result.body['code']).toBe('not_restartable')
  })

  test('a restart without fences.expectedGeneration is refused 400 before HRC is called', async () => {
    const calls: RestartCall[] = []
    const result = await restart(seatRestartCall(calls), stores(), {
      fences: {},
    })

    expect(result.status).toBe(400)
    expect(result.body).toMatchObject({
      error: {
        message: 'fences.expectedGeneration is required',
        details: { field: 'fences.expectedGeneration' },
      },
    })
    expect(calls).toHaveLength(0)
  })
})
