/**
 * T-10850 — `POST /v1/mobile/sessions/:hostSessionId/restart` (ADR hrc-ios
 * architecture/adr/2026-10-14-semantic-session-restart.md).
 *
 * Failure modes this guards:
 *  - ACP expires queued input on a refusal (F2: a refusal must change nothing)
 *  - the post-commit expiry cancels input composed for the successor
 *  - the HRC refusal codes collapse into one opaque failure the leaf can't act on
 *  - a missing generation fence restarts whatever generation is current now
 */
import { describe, expect, test } from 'bun:test'

import type { HrcSessionRecord } from 'hrc-core'

import {
  type AcpHrcClient,
  InMemoryInputAdmissionStore,
  InMemoryInputQueueStore,
  InMemoryRunStore,
} from '../src/index.js'
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

type RestartCall = { hostSessionId: string; expectedGeneration: number }

function hrcError(code: string, message: string, detail: Record<string, unknown> = {}) {
  return Object.assign(new Error(message), { code, detail })
}

function makeHrcClient(input: {
  calls: RestartCall[]
  refuse?: Error | undefined
}): AcpHrcClient {
  return {
    getSession: async (hostSessionId: string) => {
      if (hostSessionId !== PRIOR) throw hrcError('unknown_session', 'unknown session')
      return SESSION
    },
    restartSession: async (request: RestartCall) => {
      input.calls.push(request)
      if (input.refuse !== undefined) throw input.refuse
      return {
        priorHostSessionId: PRIOR,
        hostSessionId: SUCCESSOR,
        generation: 4,
        launch: { status: 'started', runtimeId: 'rt-successor' },
      }
    },
  } as unknown as AcpHrcClient
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
  hrcClient: AcpHrcClient,
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
    { hrcClient, ...s }
  )
}

describe('POST /v1/mobile/sessions/:hostSessionId/restart', () => {
  test('restarts with the fence and expires only input composed for the dropped context', async () => {
    const calls: RestartCall[] = []
    const store = stores()
    const items = seedQueue(store)

    const result = await restart(makeHrcClient({ calls }), store, {
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
    expect(calls).toEqual([{ hostSessionId: PRIOR, expectedGeneration: 3 }])
    expect(store.inputQueueStore.getById(items.prior.queueItemId)?.status).toBe('expired')
    expect(store.inputQueueStore.getById(items.unfenced.queueItemId)?.status).toBe('expired')
    expect(store.inputQueueStore.getById(items.successor.queueItemId)?.status).toBe('queued')
    expect(store.inputQueueStore.getById(items.followLatest.queueItemId)?.status).toBe('queued')
  })

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
        makeHrcClient({ calls, refuse: hrcError(hrcCode, `refused: ${hrcCode}`, detail) }),
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
      makeHrcClient({
        calls: [],
        refuse: hrcError('runtime_unavailable', 'participant', {
          reason: 'participant_rotation_unsupported',
        }),
      }),
      stores(),
      { fences: { expectedGeneration: 3 } }
    )

    expect(result.status).toBe(422)
    expect(result.body['code']).toBe('not_restartable')
  })

  test('requires the generation fence', async () => {
    const calls: RestartCall[] = []
    const result = await restart(makeHrcClient({ calls }), stores(), {
      fences: {},
    })

    expect(result.status).toBe(400)
    expect(calls).toHaveLength(0)
  })
})
