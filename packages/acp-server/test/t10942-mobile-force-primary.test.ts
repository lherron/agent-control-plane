import { describe, expect, test } from 'bun:test'

import type { AcpHrcClient } from '../src/deps.js'
import {
  type SeatRestartCall,
  SeatRestartRefusal,
  type SeatRestartResult,
} from '../src/seat-restart-client.js'
import { withWiredServer } from './fixtures/wired-server.js'

const scopeRef = 'agent:mable:project:scratch-t10942:task:primary'
const sessionRef = `${scopeRef}/lane:main`
const target = { seat: sessionRef, idempotencyKey: 'phone-key' }
const force = { mode: 'new_context' }
const reconcile = { mode: 'reconcile' }
const hostSessionId = 'hsid-successor'
const priorHostSessionId = 'hsid-prior'
const launch = { status: 'started', runtimeId: 'rt-successor' } as const

const restarted = {
  outcome: 'restarted',
  scopeRef,
  sessionRef,
  hostSessionId,
  priorHostSessionId,
  generation: 4,
  launch,
} as const

async function postForce(seatRestartCall: SeatRestartCall, fields: Record<string, unknown> = {}) {
  return await withWiredServer(
    async ({ request, json }) => {
      const response = await request({
        method: 'POST',
        path: '/v1/mobile/sessions',
        body: {
          agentId: 'mable',
          projectId: 'scratch-t10942',
          taskId: 'primary',
          requestId: target.idempotencyKey,
          force,
          ...fields,
        },
      })
      return { status: response.status, body: await json<Record<string, unknown>>(response) }
    },
    { hrcClient: {} as AcpHrcClient, seatRestartCall }
  )
}

describe('POST /v1/mobile/sessions with force', () => {
  test.each(['restarted', 'created', 'launched'] as const)(
    'forwards model and prompt, and projects the kernel %s result',
    async (outcome) => {
      const firstTurn = {
        delivered: true,
        runId: 'run',
        submissionId: 'submission',
        via: 'birth',
      } as const
      const result = await postForce(
        async (operation, args) => {
          expect(operation).toBe('seat-restart.force')
          expect(args).toEqual({
            ...target,
            ...(outcome === 'launched'
              ? {
                  mode: 'launch_successor',
                  expectedHostSessionId: hostSessionId,
                  expectedGeneration: 4,
                }
              : force),
            provision: { model: 'sonnet' },
            firstTurn: 'start here',
          })
          return { ...restarted, outcome, firstTurn, replayed: true }
        },
        {
          model: 'sonnet',
          initialPrompt: '  start here  ',
          ...(outcome === 'launched'
            ? {
                force: {
                  mode: 'launch_successor',
                  expectedHostSessionId: hostSessionId,
                  expectedGeneration: 4,
                },
              }
            : {}),
        }
      )
      expect(result.status).toBe(200)
      expect(result.body).toMatchObject({
        disposition: outcome,
        claimedScope: 'mable@scratch-t10942:primary',
        hostSessionId,
        generation: 4,
        launch,
        status: 'started',
        replayed: true,
        initialPrompt: { delivered: true, runId: 'run', submissionId: 'submission' },
      })
      expect(result.body['initialPrompt']).not.toHaveProperty('via')
    }
  )

  test('projects a committed restart with a failed launch and undelivered prompt', async () => {
    const failedLaunch = {
      status: 'failed',
      code: 'runtime_unavailable',
      message: 'failed',
    } as const
    const result = await postForce(
      async () => ({
        ...restarted,
        launch: failedLaunch,
        firstTurn: { delivered: false, reason: 'launch_failed' },
      }),
      { initialPrompt: 'start here' }
    )
    expect(result.status).toBe(200)
    expect(result.body).toMatchObject({
      disposition: 'restarted',
      launch: failedLaunch,
      initialPrompt: { delivered: false, reason: 'launch_failed' },
    })
    expect(result.body).not.toHaveProperty('runtimeId')
  })

  test('times out once and reconciles with the original requestId', async () => {
    const calls: Record<string, unknown>[] = []
    const result = await postForce(
      async (_op, args) => {
        calls.push(args)
        if (calls.length === 1) throw new SeatRestartRefusal('call_timeout', 'timed out')
        return { ...restarted, replayed: true }
      },
      { model: 'sonnet', initialPrompt: 'start here' }
    )
    expect(calls).toEqual([
      { ...target, ...force, provision: { model: 'sonnet' }, firstTurn: 'start here' },
      { ...target, ...reconcile },
    ])
    expect(result.status).toBe(200)
    expect(result.body).toMatchObject({ replayed: true })
  })

  test('unknown reconciliation retains the active head and the phone 502 status', async () => {
    const active = { hostSessionId, generation: 4, sessionRef }
    const result = await postForce(
      async (_op, args): Promise<SeatRestartResult> => {
        expect(args).toEqual({ ...target, ...reconcile })
        return { outcome: 'unknown', active }
      },
      { force: reconcile, model: 'sonnet', initialPrompt: 'start here' }
    )
    expect(result).toMatchObject({
      status: 502,
      body: { code: 'force_outcome_unknown', requestId: target.idempotencyKey, detail: { active } },
    })
  })

  test('preserves model refusal details with the owner’s 409 status', async () => {
    const detail = { hostSessionId, priorHostSessionId, generation: 4, launch }
    const result = await postForce(
      async () => {
        throw new SeatRestartRefusal('model_not_preserved', 'model changed', detail)
      },
      { model: 'sonnet' }
    )
    expect(result).toMatchObject({
      status: 409,
      body: { code: 'model_not_preserved', requestId: target.idempotencyKey, detail },
    })
  })

  test('refuses force on any scope except primary before calling the kernel', async () => {
    const result = await postForce(
      async () => {
        throw new Error('kernel should not be called')
      },
      { taskId: 'minisvc' }
    )
    expect(result).toMatchObject({
      status: 400,
      body: { error: { details: { field: 'force' } } },
    })
  })
})
