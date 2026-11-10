import { Database } from 'bun:sqlite'
import { describe, expect, test } from 'bun:test'
import type { HrcDispatchOrigin } from 'hrc-core'
import { InMemoryInputAttemptStore } from '../src/domain/input-attempt-store.js'
import { InMemoryRunStore } from '../src/domain/run-store.js'
import { createRealLauncher } from '../src/real-launcher.js'
import { createHrcRouteFake } from './fixtures/hrc-route-fake.js'

async function captureDispatchOrigin(input: {
  actor: { kind: 'human' | 'agent' | 'system'; id: string }
  metadata?: Readonly<Record<string, unknown>> | undefined
  missingAttempt?: boolean
}): Promise<HrcDispatchOrigin | undefined> {
  const inputAttemptStore = new InMemoryInputAttemptStore()
  const runStore = new InMemoryRunStore()
  const sessionRef = {
    scopeRef: 'agent:fettle:project:agent-control-plane:task:T-07237-origin-test',
    laneRef: 'main' as const,
  }
  const attempt = inputAttemptStore.createAttempt({
    sessionRef,
    content: 'origin test',
    actor: input.actor,
    ...(input.metadata !== undefined ? { metadata: input.metadata } : {}),
  }).inputAttempt
  const acpRun = runStore.createRun({
    sessionRef,
    actor: input.missingAttempt
      ? input.actor
      : { kind: 'system', id: 'wrong-fallback-must-not-win' },
    metadata: { meta: input.metadata },
    status: 'pending',
  })
  let origin: HrcDispatchOrigin | undefined
  const launcher = createRealLauncher({
    hrc: createHrcRouteFake(new Database(':memory:')),
    inputAttemptStore,
    createClient: () =>
      ({
        resolveSession: async () => ({
          found: true,
          hostSessionId: 'hsid-origin-test',
          generation: 1,
        }),
        dispatchTurn: async (request: {
          origin?: HrcDispatchOrigin | undefined
        }) => {
          origin = request.origin
          return {
            runId: 'hrc-run-origin-test',
            hostSessionId: 'hsid-origin-test',
            generation: 1,
            runtimeId: 'rt-origin-test',
            transport: 'headless',
            status: 'accepted',
          }
        },
      }) as unknown as any,
  })

  await launcher({
    sessionRef,
    intent: {
      placement: {
        agentRoot: '/tmp/fettle',
        runMode: 'task',
        bundle: { kind: 'compose', compose: [] },
      },
      harness: { provider: 'openai', interactive: false },
      initialPrompt: 'origin test',
    },
    acpRunId: acpRun.runId,
    inputAttemptId: input.missingAttempt ? 'missing' : attempt.inputAttemptId,
    runStore,
    waitForCompletion: false,
  })

  return origin
}

describe('real launcher dispatch metadata', () => {
  test('threads agent origin and job-run causation from the durable input attempt', async () => {
    expect(
      await captureDispatchOrigin({
        actor: { kind: 'agent', id: 'cody' },
        metadata: {
          source: { kind: 'job', jobId: 'job_t07237', jobRunId: 'jrun_t07237' },
        },
      })
    ).toEqual({
      actor: 'agent:cody',
      kind: 'agent',
      causationRef: 'jrun_t07237',
    })
  })

  test('threads human origin without causation for non-job input', async () => {
    expect(
      await captureDispatchOrigin({
        actor: { kind: 'human', id: 'lherron' },
        metadata: { source: { kind: 'interface', gatewayId: 'discord' } },
      })
    ).toEqual({ actor: 'human:lherron', kind: 'human' })
  })

  test('missing input metadata degrades to actor-only origin without blocking dispatch', async () => {
    expect(
      await captureDispatchOrigin({
        actor: { kind: 'agent', id: 'agent:already-canonical' },
      })
    ).toEqual({ actor: 'agent:already-canonical', kind: 'agent' })
  })

  test('missing durable attempt falls back to run actor and nested job source', async () => {
    expect(
      await captureDispatchOrigin({
        missingAttempt: true,
        actor: { kind: 'system', id: 'system:scheduler' },
        metadata: { source: { kind: 'job', jobRunId: 'jrun_fallback' } },
      })
    ).toEqual({ actor: 'system:scheduler', kind: 'system', causationRef: 'jrun_fallback' })
  })

  describe('first-turn timeout override passthrough', () => {
    const OVERRIDE_SCOPE = 'agent:fettle:project:agent-control-plane:task:T-07237-origin-test'

    async function captureFirstTurnTimeout(env: {
      scope?: string | undefined
      ms?: string | undefined
    }): Promise<number | undefined> {
      const priorScope = process.env['ACP_HRC_FIRST_TURN_TIMEOUT_SCOPE']
      const priorMs = process.env['ACP_HRC_FIRST_TURN_TIMEOUT_MS']
      if (env.scope === undefined)
        Reflect.deleteProperty(process.env, 'ACP_HRC_FIRST_TURN_TIMEOUT_SCOPE')
      else process.env['ACP_HRC_FIRST_TURN_TIMEOUT_SCOPE'] = env.scope
      if (env.ms === undefined) Reflect.deleteProperty(process.env, 'ACP_HRC_FIRST_TURN_TIMEOUT_MS')
      else process.env['ACP_HRC_FIRST_TURN_TIMEOUT_MS'] = env.ms

      const inputAttemptStore = new InMemoryInputAttemptStore()
      const runStore = new InMemoryRunStore()
      const sessionRef = { scopeRef: OVERRIDE_SCOPE, laneRef: 'main' as const }
      const attempt = inputAttemptStore.createAttempt({
        sessionRef,
        content: 'timeout override test',
        actor: { kind: 'agent', id: 'mable' },
      }).inputAttempt
      const acpRun = runStore.createRun({
        sessionRef,
        actor: { kind: 'agent', id: 'mable' },
        status: 'pending',
      })
      let captured: number | undefined
      try {
        const launcher = createRealLauncher({
          hrc: createHrcRouteFake(new Database(':memory:')),
          inputAttemptStore,
          createClient: () =>
            ({
              resolveSession: async () => ({
                found: true,
                hostSessionId: 'hsid-timeout-test',
                generation: 1,
              }),
              dispatchTurn: async (request: {
                firstTurnTimeoutMs?: number | undefined
              }) => {
                captured = request.firstTurnTimeoutMs
                return {
                  runId: 'hrc-run-timeout-test',
                  hostSessionId: 'hsid-timeout-test',
                  generation: 1,
                  runtimeId: 'rt-timeout-test',
                  transport: 'headless',
                  status: 'accepted',
                }
              },
            }) as unknown as any,
        })
        await launcher({
          sessionRef,
          intent: {
            placement: {
              agentRoot: '/tmp/fettle',
              runMode: 'task',
              bundle: { kind: 'compose', compose: [] },
            },
            harness: { provider: 'openai', interactive: false },
            initialPrompt: 'timeout override test',
          },
          acpRunId: acpRun.runId,
          inputAttemptId: attempt.inputAttemptId,
          runStore,
          waitForCompletion: false,
        })
      } finally {
        if (priorScope === undefined)
          Reflect.deleteProperty(process.env, 'ACP_HRC_FIRST_TURN_TIMEOUT_SCOPE')
        else process.env['ACP_HRC_FIRST_TURN_TIMEOUT_SCOPE'] = priorScope
        if (priorMs === undefined)
          Reflect.deleteProperty(process.env, 'ACP_HRC_FIRST_TURN_TIMEOUT_MS')
        else process.env['ACP_HRC_FIRST_TURN_TIMEOUT_MS'] = priorMs
      }
      return captured
    }

    test('passes the override only when scope matches exactly', async () => {
      expect(await captureFirstTurnTimeout({ scope: OVERRIDE_SCOPE, ms: '1000' })).toBe(1000)
    })

    test('override env for a different scope sends no firstTurnTimeoutMs', async () => {
      expect(
        await captureFirstTurnTimeout({
          scope: 'agent:smokey:project:hrc-runtime:task:bridge-echo',
          ms: '1000',
        })
      ).toBeUndefined()
    })

    test('does not pass the override when env is unset or malformed', async () => {
      expect(await captureFirstTurnTimeout({})).toBeUndefined()
      expect(await captureFirstTurnTimeout({ scope: OVERRIDE_SCOPE, ms: 'soon' })).toBeUndefined()
      expect(await captureFirstTurnTimeout({ scope: OVERRIDE_SCOPE, ms: '-5' })).toBeUndefined()
    })
  })
})
