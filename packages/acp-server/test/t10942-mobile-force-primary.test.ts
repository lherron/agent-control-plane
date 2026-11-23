/**
 * T-10942 — "Force new session" on `POST /v1/mobile/sessions`
 * (hrc-ios IOS_FORCE_NEW_PRIMARY_PROPOSAL.md).
 *
 * Failure modes this guards:
 *  - force off stops suffixing, or force on still walks the suffix roster
 *  - force restarts without HRC's generation fence, or without `force: true`
 *  - a refusal (or a lost answer) expires queued input; a commit expires the
 *    successor's input or `follow_latest`
 *  - a remote-homed primary is duplicated locally
 *  - a committed restart with a failed launch reads as a refusal
 *  - a resubmitted requestId restarts twice
 *  - an unanswered HRC call is settled by guessing from a head snapshot
 *  - a failed exact claim is attributed by what sits at the scope instead of
 *    by HRC's idempotency key
 *  - Launch recovery rotates the successor or starts a head that already moved
 *  - a phone-selected model is dropped on any force branch, or a force with no
 *    model sends HRC anything new (T-13968)
 */
import { describe, expect, test } from 'bun:test'

import { HrcDomainError, HrcErrorCode } from 'hrc-core'
import type { HrcSessionRecord } from 'hrc-core'

import type { AcpRuntimePlacement } from '../src/deps.js'
import { deriveMobileSessionIdempotencyKey } from '../src/handlers/mobile-sessions-create.js'
import type { HrcRouteReader } from '../src/hrc-route-reader.js'
import {
  type AcpHrcClient,
  InMemoryInputAdmissionStore,
  InMemoryInputQueueStore,
  InMemoryRunStore,
} from '../src/index.js'
import { withWiredServer } from './fixtures/wired-server.js'

const NOW = '2026-10-14T12:00:00.000Z'
const SCOPE = 'agent:mable:project:scratch-t10942:task:primary'
const SESSION_REF = `${SCOPE}/lane:main`
const PRIOR = 'hsid-prior'
const SUCCESSOR = 'hsid-successor'
const TEST_AGENT_ROOT = new URL('./fixtures/mobile-agent/', import.meta.url).pathname

type Head = { hostSessionId: string; generation: number } | null

type Calls = {
  restarts: Record<string, unknown>[]
  starts: Record<string, unknown>[]
  resolves: number
  steers: Parameters<AcpHrcClient['steer']>[0][]
}

type Script = {
  /** Heads returned by successive resolveSession calls; the last one repeats. */
  heads: Head[]
  homeNodeId?: string
  restart?: (request: Record<string, unknown>) => unknown
  start?: (request: Record<string, unknown>) => unknown
  readRuntimes?: HrcRouteReader['readRuntimes']
}

function session(head: NonNullable<Head>): HrcSessionRecord {
  return {
    hostSessionId: head.hostSessionId,
    scopeRef: SCOPE,
    laneRef: 'main',
    generation: head.generation,
    status: 'active',
    createdAt: NOW,
    updatedAt: NOW,
  }
}

function hrcClient(script: Script, calls: Calls): AcpHrcClient {
  return {
    steer: async (request: Parameters<AcpHrcClient['steer']>[0]) => {
      calls.steers.push(request)
      return { admission: 'admitted', submissionId: 'hrc-force-steer', runId: 'run-force-steer' }
    },
    resolveRuntimeIntent: async (request: Record<string, unknown>) => ({
      intent: {
        harness: { provider: 'anthropic', interactive: true, id: 'claude-code' },
        execution: { preferredMode: 'headless' },
        placement: { agentRoot: request['agentRoot'] },
        // HRC echoes a requested model as provision and summon directive.
        ...(request['provision'] !== undefined
          ? {
              provision: request['provision'],
              summonDirectives: request['provision'],
            }
          : {}),
      },
      declaration: {
        release: { releaseId: 'test-release', sourceCommit: 'test-commit' },
        agentSources: { provenance: 'caller-agent-root' },
        source: {},
        warnings: [],
      },
    }),
    resolveSession: async () => {
      const head = script.heads[Math.min(calls.resolves, script.heads.length - 1)] ?? null
      calls.resolves += 1
      if (head === null) {
        return {
          found: false,
          hostSessionId: null,
          generation: null,
          created: false,
          session: null,
        }
      }
      return {
        found: true,
        hostSessionId: head.hostSessionId,
        generation: head.generation,
        created: false,
        session: session(head),
        ...(script.homeNodeId !== undefined ? { homeNodeId: script.homeNodeId } : {}),
      }
    },
    restartSession: async (request: Record<string, unknown>) => {
      calls.restarts.push(request)
      if (script.restart !== undefined) return script.restart(request)
      return {
        priorHostSessionId: PRIOR,
        hostSessionId: SUCCESSOR,
        generation: 4,
        launch: { status: 'started', runtimeId: 'rt-successor' },
        // HRC echoes the successor intent's directive block.
        ...(request['provision'] !== undefined ? { summonDirectives: request['provision'] } : {}),
      }
    },
    startRuntime: async (request: Record<string, unknown>) => {
      calls.starts.push(request)
      if (script.start !== undefined) return script.start(request)
      return {
        runtimeId: 'rt-started',
        hostSessionId: SUCCESSOR,
        transport: 'tmux',
        status: 'ready',
        ...(request['conflictPolicy'] === undefined
          ? {}
          : {
              claim: {
                slot: request['conflictPolicy'] === 'reject' ? 'primary' : 'primary-nova',
                scopeRef: request['conflictPolicy'] === 'reject' ? SCOPE : `${SCOPE}-nova`,
                sessionRef:
                  request['conflictPolicy'] === 'reject' ? SESSION_REF : `${SCOPE}-nova/lane:main`,
                hostSessionId: SUCCESSOR,
                idempotencyKey: request['idempotencyKey'],
                replayed: false,
              },
            }),
      }
    },
  } as unknown as AcpHrcClient
}

function runtimeResolver(): AcpRuntimePlacement {
  return {
    agentRoot: TEST_AGENT_ROOT,
    projectRoot: '/tmp/praesidium-test-projects/scratch-t10942',
    cwd: '/tmp/praesidium-test-projects/scratch-t10942',
    runMode: 'task',
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

function seedQueue(s: Stores) {
  return {
    prior: enqueue(s, 'prior', 1, { hostSessionId: PRIOR, generation: 3 }),
    unfenced: enqueue(s, 'loose', 2, undefined),
    successor: enqueue(s, 'successor', 3, { hostSessionId: SUCCESSOR, generation: 4 }),
    followLatest: enqueue(s, 'follow', 4, undefined, 'follow_latest'),
  }
}

function statuses(s: Stores, items: ReturnType<typeof seedQueue>) {
  return Object.fromEntries(
    Object.entries(items).map(([name, item]) => [
      name,
      s.inputQueueStore.getById(item.queueItemId)?.status,
    ])
  )
}

const ALL_QUEUED = {
  prior: 'queued',
  unfenced: 'queued',
  successor: 'queued',
  followLatest: 'queued',
}

function emptyCalls(): Calls {
  return { restarts: [], starts: [], resolves: 0, steers: [] }
}

type Post = (
  body: Record<string, unknown>
) => Promise<{ status: number; body: Record<string, unknown> }>

/** One wired server (one ACP, one ledger) for a whole scenario. */
async function scenario(
  script: Script,
  s: Stores,
  run: (post: Post, calls: Calls) => Promise<void>
): Promise<void> {
  const calls = emptyCalls()
  await withWiredServer(
    async ({ request, json }) => {
      const post: Post = async (body) => {
        const response = await request({
          method: 'POST',
          path: '/v1/mobile/sessions',
          body: { agentId: 'mable', projectId: 'scratch-t10942', taskId: 'primary', ...body },
        })
        return { status: response.status, body: await json<Record<string, unknown>>(response) }
      }
      await run(post, calls)
    },
    {
      hrcClient: hrcClient(script, calls),
      hrcRoutes:
        script.readRuntimes === undefined
          ? undefined
          : ({ readRuntimes: script.readRuntimes } as HrcRouteReader),
      runtimeResolver,
      ...s,
    }
  )
}

const FORCE = { force: { mode: 'new_context' } }
const RECONCILE = { force: { mode: 'reconcile' } }

describe('POST /v1/mobile/sessions with force', () => {
  test.each(['created', 'restarted'] as const)(
    'steers once when force %s returns a fresh runtime',
    async (disposition) => {
      await scenario(
        {
          heads:
            disposition === 'created'
              ? [null, { hostSessionId: SUCCESSOR, generation: 1 }]
              : [{ hostSessionId: PRIOR, generation: 3 }],
          readRuntimes: async () => [
            {
              runtimeId: disposition === 'created' ? 'rt-started' : 'rt-successor',
              hostSessionId: SUCCESSOR,
              status: 'ready',
              createdAt: new Date().toISOString(),
            },
          ],
        },
        stores(),
        async (post, calls) => {
          const request = {
            ...FORCE,
            requestId: 'req-force-prompt',
            initialPrompt: '  start here  ',
          }
          const result = await post(request)
          expect(result.status).toBe(200)
          const idempotencyKey = `${deriveMobileSessionIdempotencyKey(request.requestId)}:initial-prompt`
          expect(result.body).toMatchObject({
            disposition,
            initialPrompt: { delivered: true, idempotencyKey },
          })
          if (disposition === 'created') {
            expect(calls.starts[0]).toMatchObject({
              runtimeIntent: { initialPrompt: 'start here' },
            })
          }
          expect((await post(request)).body).toMatchObject({
            replayed: true,
            initialPrompt: { delivered: false, reason: 'runtime_not_fresh' },
          })
          expect((await post({ ...request, initialPrompt: 'changed' })).status).toBe(409)
          expect(calls.steers).toEqual([
            {
              target: SESSION_REF,
              body: 'start here',
              origin: { principalRef: 'agent:lance' },
              idempotencyKey,
            },
          ])
        }
      )
    }
  )

  test('force off keeps the suffix roster and never restarts', async () => {
    await scenario(
      { heads: [{ hostSessionId: PRIOR, generation: 3 }] },
      stores(),
      async (post, calls) => {
        const result = await post({ requestId: 'req-off' })
        expect(result.status).toBe(200)
        expect(calls.restarts).toHaveLength(0)
        expect(calls.resolves).toBe(0)
        expect(calls.starts[0]).toMatchObject({ conflictPolicy: 'suffix' })
      }
    )
  })

  test('restarts the exact primary with its fence and cleans only the dropped context', async () => {
    const s = stores()
    const items = seedQueue(s)
    await scenario({ heads: [{ hostSessionId: PRIOR, generation: 3 }] }, s, async (post, calls) => {
      const result = await post({ requestId: 'req-restart', ...FORCE })
      expect(result.status).toBe(200)
      expect(result.body).toEqual({
        disposition: 'restarted',
        claimedScope: 'mable@scratch-t10942:primary',
        sessionRef: SESSION_REF,
        hostSessionId: SUCCESSOR,
        generation: 4,
        priorHostSessionId: PRIOR,
        launch: { status: 'started', runtimeId: 'rt-successor' },
        runtimeId: 'rt-successor',
        status: 'started',
        replayed: false,
      })
      expect(calls.restarts).toEqual([{ hostSessionId: PRIOR, expectedGeneration: 3, force: true }])
      expect(calls.starts).toHaveLength(0)
    })
    expect(statuses(s, items)).toEqual({
      prior: 'expired',
      unfenced: 'expired',
      successor: 'queued',
      followLatest: 'queued',
    })
  })

  test('claims an absent primary exactly, never a suffix', async () => {
    await scenario(
      { heads: [null, { hostSessionId: SUCCESSOR, generation: 1 }] },
      stores(),
      async (post, calls) => {
        const result = await post({ requestId: 'req-absent', ...FORCE })
        expect(result.status).toBe(200)
        expect(result.body).toMatchObject({
          disposition: 'created',
          claimedScope: 'mable@scratch-t10942:primary',
          hostSessionId: SUCCESSOR,
          generation: 1,
          launch: { status: 'started', runtimeId: 'rt-started' },
        })
        expect(calls.restarts).toHaveLength(0)
        expect(calls.starts).toHaveLength(1)
        expect(calls.starts[0]).toMatchObject({
          sessionRef: SESSION_REF,
          conflictPolicy: 'reject',
          idempotencyKey: deriveMobileSessionIdempotencyKey('req-absent'),
        })
        expect('baseSessionRef' in (calls.starts[0] as object)).toBe(false)
      }
    )
  })

  test('refuses a remote-homed primary without creating anything', async () => {
    await scenario(
      { heads: [{ hostSessionId: PRIOR, generation: 3 }], homeNodeId: 'mini' },
      stores(),
      async (post, calls) => {
        const result = await post({ requestId: 'req-remote', ...FORCE })
        expect(result.status).toBe(422)
        expect(result.body).toMatchObject({ ok: false, code: 'remote_scope_unsupported' })
        expect(calls.restarts).toHaveLength(0)
        expect(calls.starts).toHaveLength(0)
      }
    )
  })

  test('passes an HRC refusal through and changes no queued input', async () => {
    const s = stores()
    const items = seedQueue(s)
    await scenario(
      {
        heads: [{ hostSessionId: PRIOR, generation: 3 }],
        restart: () => {
          throw new HrcDomainError(HrcErrorCode.STALE_CONTEXT, 'moved on', {
            activeHostSessionId: SUCCESSOR,
            activeGeneration: 4,
          })
        },
      },
      s,
      async (post) => {
        const result = await post({ requestId: 'req-stale', ...FORCE })
        expect(result.status).toBe(409)
        expect(result.body).toMatchObject({
          ok: false,
          code: 'stale_context',
          requestId: 'req-stale',
        })
      }
    )
    expect(statuses(s, items)).toEqual(ALL_QUEUED)
  })

  test('reports a committed restart whose launch failed as a commit, not a refusal', async () => {
    await scenario(
      {
        heads: [{ hostSessionId: PRIOR, generation: 3 }],
        restart: () => ({
          priorHostSessionId: PRIOR,
          hostSessionId: SUCCESSOR,
          generation: 4,
          launch: { status: 'failed', code: 'runtime_unavailable', message: 'no harness' },
        }),
      },
      stores(),
      async (post) => {
        const result = await post({ requestId: 'req-launch-fail', ...FORCE })
        expect(result.status).toBe(200)
        expect(result.body).toMatchObject({
          disposition: 'restarted',
          hostSessionId: SUCCESSOR,
          generation: 4,
          launch: { status: 'failed', code: 'runtime_unavailable', message: 'no harness' },
        })
        expect('runtimeId' in result.body).toBe(false)
      }
    )
  })

  test('a resubmitted requestId replays the outcome and never restarts twice', async () => {
    await scenario(
      { heads: [{ hostSessionId: PRIOR, generation: 3 }] },
      stores(),
      async (post, calls) => {
        const [first, second] = await Promise.all([
          post({ requestId: 'req-dup', ...FORCE }),
          post({ requestId: 'req-dup', ...FORCE }),
        ])
        const third = await post({ requestId: 'req-dup', ...RECONCILE })
        expect(calls.restarts).toHaveLength(1)
        expect([first.body['replayed'], second.body['replayed']].sort()).toEqual([false, true])
        expect(third.status).toBe(200)
        expect(third.body).toMatchObject({ hostSessionId: SUCCESSOR, replayed: true })
      }
    )
  })

  test('refuses the same requestId for a different agent', async () => {
    await scenario(
      { heads: [{ hostSessionId: PRIOR, generation: 3 }] },
      stores(),
      async (post, calls) => {
        await post({ requestId: 'req-shared', ...FORCE })
        const other = await post({ requestId: 'req-shared', agentId: 'clod', ...FORCE })
        expect(other.status).toBe(409)
        expect(other.body).toMatchObject({ code: 'idempotency_key_conflict' })
        expect(calls.restarts).toHaveLength(1)
      }
    )
  })

  test('an unanswered restart settles read-only: no verdict, no cleanup, no second restart', async () => {
    const s = stores()
    const items = seedQueue(s)
    await scenario(
      {
        // HRC committed the restart, then the answer was lost.
        heads: [
          { hostSessionId: PRIOR, generation: 3 },
          { hostSessionId: SUCCESSOR, generation: 4 },
        ],
        restart: () => {
          throw new Error('socket hang up')
        },
      },
      s,
      async (post, calls) => {
        const submit = await post({ requestId: 'req-lost', ...FORCE })
        expect(submit.status).toBe(502)
        expect(submit.body).toMatchObject({ code: 'force_outcome_unknown' })

        for (const body of [RECONCILE, FORCE]) {
          const settled = await post({ requestId: 'req-lost', ...body })
          expect(settled.status).toBe(409)
          expect(settled.body).toMatchObject({
            code: 'force_outcome_unknown',
            detail: {
              active: { hostSessionId: SUCCESSOR, generation: 4, sessionRef: SESSION_REF },
            },
          })
        }
        expect(calls.restarts).toHaveLength(1)
      }
    )
    expect(statuses(s, items)).toEqual(ALL_QUEUED)
  })

  test('an unknown requestId reconciles read-only', async () => {
    await scenario(
      { heads: [{ hostSessionId: PRIOR, generation: 3 }] },
      stores(),
      async (post, calls) => {
        const result = await post({ requestId: 'req-unknown', ...RECONCILE })
        expect(result.status).toBe(409)
        expect(result.body).toMatchObject({
          code: 'force_outcome_unknown',
          detail: { active: { hostSessionId: PRIOR, generation: 3 } },
        })
        expect(calls.restarts).toHaveLength(0)
        expect(calls.starts).toHaveLength(0)
      }
    )
  })

  test('an unanswered exact claim settles by re-issuing the same idempotency key', async () => {
    let attempts = 0
    await scenario(
      {
        heads: [null, { hostSessionId: SUCCESSOR, generation: 1 }],
        start: (request) => {
          attempts += 1
          if (attempts === 1) {
            throw new HrcDomainError(HrcErrorCode.RUNTIME_UNAVAILABLE, 'launch failed', {})
          }
          return {
            runtimeId: 'rt-replayed',
            hostSessionId: SUCCESSOR,
            transport: 'tmux',
            status: 'ready',
            claim: {
              slot: 'primary',
              scopeRef: SCOPE,
              sessionRef: SESSION_REF,
              hostSessionId: SUCCESSOR,
              idempotencyKey: request['idempotencyKey'],
              replayed: true,
            },
          }
        },
      },
      stores(),
      async (post, calls) => {
        const submit = await post({ requestId: 'req-claim', ...FORCE })
        expect(submit.status).toBe(502)
        expect(submit.body).toMatchObject({ code: 'force_outcome_unknown' })

        const settled = await post({ requestId: 'req-claim', ...RECONCILE })
        expect(settled.status).toBe(200)
        expect(settled.body).toMatchObject({
          disposition: 'created',
          hostSessionId: SUCCESSOR,
          launch: { status: 'started', runtimeId: 'rt-replayed' },
          replayed: true,
        })
        expect(calls.starts.map((start) => start['idempotencyKey'])).toEqual([
          deriveMobileSessionIdempotencyKey('req-claim'),
          deriveMobileSessionIdempotencyKey('req-claim'),
        ])
      }
    )
  })

  test('an occupied exact scope refuses without a suffix', async () => {
    await scenario(
      {
        heads: [null],
        start: () => {
          throw new HrcDomainError(HrcErrorCode.SESSION_SCOPE_OCCUPIED, 'occupied', {})
        },
      },
      stores(),
      async (post, calls) => {
        const result = await post({ requestId: 'req-occupied', ...FORCE })
        expect(result.status).toBe(409)
        expect(result.body).toMatchObject({ code: 'session_scope_occupied' })
        // One exact start, no roster fallback after the refusal.
        expect(calls.starts).toHaveLength(1)
        expect(calls.starts[0]).toMatchObject({ conflictPolicy: 'reject' })
        expect('baseSessionRef' in (calls.starts[0] as object)).toBe(false)
      }
    )
  })

  test('force is refused for any scope but primary', async () => {
    await scenario({ heads: [null] }, stores(), async (post, calls) => {
      const result = await post({ requestId: 'req-minisvc', taskId: 'minisvc', ...FORCE })
      expect(result.status).toBe(400)
      expect(result.body).toMatchObject({
        error: {
          message: 'force is only supported for the primary scope',
          details: { field: 'force' },
        },
      })
      expect(calls.restarts).toHaveLength(0)
      expect(calls.starts).toHaveLength(0)
    })
  })
})

describe('Launch recovery (force.mode launch_successor)', () => {
  const LAUNCH = {
    force: { mode: 'launch_successor', expectedHostSessionId: SUCCESSOR, expectedGeneration: 4 },
  }

  test('leaves the prompt unsent when launch recovery reuses an older runtime', async () => {
    await scenario(
      {
        heads: [{ hostSessionId: SUCCESSOR, generation: 4 }],
        readRuntimes: async () => [
          {
            runtimeId: 'rt-started',
            hostSessionId: SUCCESSOR,
            status: 'ready',
            createdAt: NOW,
          },
        ],
      },
      stores(),
      async (post, calls) => {
        const result = await post({
          requestId: 'req-launch-reuse',
          ...LAUNCH,
          initialPrompt: 'keep as draft',
        })
        expect(result.status).toBe(200)
        expect(result.body).toMatchObject({
          disposition: 'launched',
          initialPrompt: { delivered: false, reason: 'runtime_not_fresh' },
        })
        expect(calls.starts[0]?.['intent']).not.toHaveProperty('initialPrompt')
        expect(calls.steers).toEqual([])
      }
    )
  })

  test('starts the successor without rotating it', async () => {
    await scenario(
      { heads: [{ hostSessionId: SUCCESSOR, generation: 4 }] },
      stores(),
      async (post, calls) => {
        const result = await post({ requestId: 'req-launch', ...LAUNCH })
        expect(result.status).toBe(200)
        expect(result.body).toMatchObject({
          disposition: 'launched',
          hostSessionId: SUCCESSOR,
          generation: 4,
          launch: { status: 'started', runtimeId: 'rt-started' },
        })
        expect(calls.restarts).toHaveLength(0)
        expect(calls.starts).toHaveLength(1)
        expect(calls.starts[0]).toMatchObject({
          hostSessionId: SUCCESSOR,
          allowStaleGeneration: true,
        })
        expect('conflictPolicy' in (calls.starts[0] as object)).toBe(false)
      }
    )
  })

  test('refuses a moved head before starting anything', async () => {
    await scenario(
      { heads: [{ hostSessionId: 'hsid-newer', generation: 5 }] },
      stores(),
      async (post, calls) => {
        const result = await post({ requestId: 'req-launch-stale', ...LAUNCH })
        expect(result.status).toBe(409)
        expect(result.body).toMatchObject({
          code: 'stale_context',
          detail: { active: { hostSessionId: 'hsid-newer', generation: 5 } },
        })
        expect(calls.starts).toHaveLength(0)
      }
    )
  })
})

describe('force with the phone-selected model (T-13968)', () => {
  const MODEL = { model: 'opus' }

  test('the restart forwards the model as a restart directive', async () => {
    await scenario(
      { heads: [{ hostSessionId: PRIOR, generation: 3 }] },
      stores(),
      async (post, calls) => {
        const result = await post({ requestId: 'req-model-restart', ...FORCE, ...MODEL })
        expect(result.status).toBe(200)
        expect(result.body).toMatchObject({ disposition: 'restarted', hostSessionId: SUCCESSOR })
        expect(calls.restarts).toEqual([
          {
            hostSessionId: PRIOR,
            expectedGeneration: 3,
            force: true,
            provision: { model: 'opus' },
          },
        ])
      }
    )
  })

  test('a successor without the requested model is reported as committed, not as success', async () => {
    const s = stores()
    const items = seedQueue(s)
    await scenario(
      {
        heads: [{ hostSessionId: PRIOR, generation: 3 }],
        restart: () => ({
          priorHostSessionId: PRIOR,
          hostSessionId: SUCCESSOR,
          generation: 4,
          launch: { status: 'started', runtimeId: 'rt-successor' },
        }),
      },
      s,
      async (post) => {
        const result = await post({ requestId: 'req-model-dropped', ...FORCE, ...MODEL })
        expect(result.status).toBe(502)
        expect(result.body).toMatchObject({
          code: 'model_not_preserved',
          detail: { hostSessionId: SUCCESSOR, generation: 4, summonDirectives: null },
        })
      }
    )
    // The rotation committed, so the dropped context's input still expires.
    expect(statuses(s, items)).toMatchObject({ prior: 'expired', successor: 'queued' })
  })

  test('a reused requestId with a different model is a conflict, not a replay', async () => {
    await scenario(
      { heads: [{ hostSessionId: PRIOR, generation: 3 }] },
      stores(),
      async (post, calls) => {
        await post({ requestId: 'req-model-reuse', ...FORCE, ...MODEL })
        const second = await post({ requestId: 'req-model-reuse', ...FORCE, model: 'sonnet' })
        expect(second.status).toBe(409)
        expect(second.body).toMatchObject({ code: 'idempotency_key_conflict' })
        expect(calls.restarts).toHaveLength(1)
      }
    )
  })

  test('an absent primary starts with the model in its intent', async () => {
    await scenario(
      { heads: [null, { hostSessionId: SUCCESSOR, generation: 1 }] },
      stores(),
      async (post, calls) => {
        const result = await post({ requestId: 'req-model-absent', ...FORCE, ...MODEL })
        expect(result.status).toBe(200)
        expect(result.body).toMatchObject({ disposition: 'created' })
        expect(calls.restarts).toHaveLength(0)
        expect(calls.starts[0]?.['runtimeIntent']).toMatchObject({
          provision: { model: 'opus' },
          summonDirectives: { model: 'opus' },
        })
      }
    )
  })

  test('launch recovery starts the successor with the model in its intent', async () => {
    await scenario(
      { heads: [{ hostSessionId: SUCCESSOR, generation: 4 }] },
      stores(),
      async (post, calls) => {
        const result = await post({
          requestId: 'req-model-launch',
          force: {
            mode: 'launch_successor',
            expectedHostSessionId: SUCCESSOR,
            expectedGeneration: 4,
          },
          ...MODEL,
        })
        expect(result.status).toBe(200)
        expect(calls.starts[0]?.['intent']).toMatchObject({
          provision: { model: 'opus' },
          summonDirectives: { model: 'opus' },
        })
      }
    )
  })
})
