import { describe, expect, spyOn, test } from 'bun:test'

import { HrcDomainError, HrcErrorCode } from 'hrc-core'
import type { StartRuntimeRequest, StartRuntimeResponse } from 'hrc-sdk'
import type { AcpRuntimePlacement } from '../src/deps.js'
import type { AcpHrcClient } from '../src/deps.js'
import {
  buildMobileStartRequest,
  deriveMobileSessionIdempotencyKey,
  resolveMobileConflictPolicy,
  resolveMobileTaskId,
} from '../src/handlers/mobile-sessions-create.js'

import { withWiredServer } from './fixtures/wired-server.js'

const BASE_SCOPE_REF = 'agent:mable:project:hrc-runtime:task:primary'
const CLAIMED_SCOPE_REF = 'agent:mable:project:hrc-runtime:task:primary-nova'
const BASE_SESSION_REF = `${BASE_SCOPE_REF}/lane:main`
const CLAIMED_SESSION_REF = `${CLAIMED_SCOPE_REF}/lane:main`
const HRCDEV_SESSION_REF = 'agent:mable:project:hrc-runtime:task:hrcdev/lane:main'
const REQUEST_ID = 'ios-press-01879d8f'
const TEST_AGENT_ROOT = new URL('./fixtures/mobile-agent/', import.meta.url).pathname

/**
 * Mirrors what HRC reports back: a suffix start claims a roster slot near the
 * base scope, while an exact start can only ever claim the scope it was given.
 */
function startedResponse(request: StartRuntimeRequest, replayed = false): StartRuntimeResponse {
  const exactSessionRef = (request as { sessionRef?: string }).sessionRef
  const claimedSessionRef = exactSessionRef ?? CLAIMED_SESSION_REF
  const claimedScopeRef = claimedSessionRef.slice(0, claimedSessionRef.indexOf('/lane:'))
  return {
    runtimeId: 'rt-mobile-new-session',
    hostSessionId: 'hsid-mobile-new-session',
    transport: 'headless',
    status: 'ready',
    supportsInFlightInput: false,
    claim: {
      slot: claimedScopeRef.slice(claimedScopeRef.lastIndexOf(':task:') + ':task:'.length),
      scopeRef: claimedScopeRef,
      sessionRef: claimedSessionRef,
      hostSessionId: 'hsid-mobile-new-session',
      idempotencyKey:
        (request as { idempotencyKey?: string }).idempotencyKey ??
        deriveMobileSessionIdempotencyKey(REQUEST_ID),
      replayed,
    },
  }
}

function createHrcClient(input: {
  onStart?: ((request: StartRuntimeRequest) => void) | undefined
  error?: HrcDomainError | undefined
}): AcpHrcClient {
  let calls = 0
  return {
    startRuntime: async (request: StartRuntimeRequest) => {
      input.onStart?.(request)
      if (input.error !== undefined) throw input.error
      return startedResponse(request, calls++ > 0)
    },
  } as unknown as AcpHrcClient
}

function runtimeResolver(): AcpRuntimePlacement {
  return {
    agentRoot: TEST_AGENT_ROOT,
    projectRoot: '/tmp/praesidium-test-projects/hrc-runtime',
    cwd: '/tmp/praesidium-test-projects/hrc-runtime',
    runMode: 'task',
  }
}

describe('mobile session idempotency and viewer defaults', () => {
  test('derives a deterministic namespaced key from the client requestId', () => {
    const first = deriveMobileSessionIdempotencyKey(REQUEST_ID)
    const retry = deriveMobileSessionIdempotencyKey(REQUEST_ID)
    const nextPress = deriveMobileSessionIdempotencyKey('ios-press-next')

    expect(first).toBe(retry)
    expect(first).not.toBe(nextPress)
    expect(first).toMatch(/^acp-mobile-session:v1:[a-f0-9]{64}$/)
    expect(first).not.toContain(REQUEST_ID)
  })

  test('defaults legacy requests to primary and trims explicit scopes', () => {
    expect(resolveMobileTaskId({})).toBe('primary')
    expect(resolveMobileTaskId({ taskId: ' minisvc ' })).toBe('minisvc')
    expect(resolveMobileTaskId({ taskId: 'minilab' })).toBe('minilab')
    expect(resolveMobileTaskId({ taskId: ' hrcdev ' })).toBe('hrcdev')
  })

  test('accepts any task id inside the canonical scope-token grammar', () => {
    expect(resolveMobileTaskId({ taskId: 'T-07301' })).toBe('T-07301')
    expect(resolveMobileTaskId({ taskId: 'primary-nova' })).toBe('primary-nova')
    expect(resolveMobileTaskId({ taskId: 'codex-01a014ac.7723' })).toBe('codex-01a014ac.7723')
    expect(resolveMobileTaskId({ taskId: 'a'.repeat(64) })).toBe('a'.repeat(64))
  })

  test('rejects task ids outside the canonical scope-token grammar', () => {
    for (const taskId of ['bad task', 'bad:task', 'bad/task', 'a'.repeat(65)]) {
      let thrown: unknown
      try {
        resolveMobileTaskId({ taskId })
      } catch (error) {
        thrown = error
      }
      expect(thrown).toBeInstanceOf(HrcDomainError)
      expect((thrown as HrcDomainError).code).toBe(HrcErrorCode.MALFORMED_REQUEST)
      expect((thrown as HrcDomainError).detail).toMatchObject({ field: 'taskId' })
    }
  })

  test('keeps the quick-pick lanes on the roster and everything else exact', () => {
    for (const taskId of ['primary', 'minisvc', 'minilab']) {
      expect(resolveMobileConflictPolicy(taskId)).toBe('suffix')
    }
    for (const taskId of ['hrcdev', 'T-07301', 'primary-nova', 'minisvc-alt', 'anything']) {
      expect(resolveMobileConflictPolicy(taskId)).toBe('reject')
    }
  })

  test('builds each HRC start shape without a host session or node assertion', () => {
    const runtimeIntent = { placement: {} } as unknown as Parameters<
      typeof buildMobileStartRequest
    >[0]['runtimeIntent']
    const shared = {
      sessionRef: HRCDEV_SESSION_REF,
      runtimeIntent,
      idempotencyKey: 'acp-mobile-session:v1:key',
    }

    expect(buildMobileStartRequest({ ...shared, conflictPolicy: 'suffix' })).toEqual({
      baseSessionRef: HRCDEV_SESSION_REF,
      runtimeIntent,
      conflictPolicy: 'suffix',
      summonIntent: 'implicit',
      idempotencyKey: 'acp-mobile-session:v1:key',
      restartStyle: 'reuse_pty',
    })
    expect(buildMobileStartRequest({ ...shared, conflictPolicy: 'reject' })).toEqual({
      sessionRef: HRCDEV_SESSION_REF,
      runtimeIntent,
      conflictPolicy: 'reject',
      summonIntent: 'implicit',
      idempotencyKey: 'acp-mobile-session:v1:key',
      restartStyle: 'reuse_pty',
    })
  })

  test('rejects an empty or non-string taskId at the body-parsing boundary', () => {
    expect(() => resolveMobileTaskId({ taskId: '   ' })).toThrow(
      /taskId must be a non-empty string/
    )
    expect(() => resolveMobileTaskId({ taskId: 7 })).toThrow(/taskId must be a non-empty string/)
  })
})

describe('POST /v1/mobile/sessions', () => {
  test('passes only the base scope to HRC and projects the claimed scope prominently', async () => {
    const starts: StartRuntimeRequest[] = []
    const hrcClient = createHrcClient({ onStart: (request) => starts.push(request) })

    await withWiredServer(
      async ({ request, json }) => {
        const response = await request({
          method: 'POST',
          path: '/v1/mobile/sessions',
          body: {
            agentId: 'mable',
            projectId: 'hrc-runtime',
            viewerWindow: 'console-e2e',
            requestId: REQUEST_ID,
          },
        })

        expect(response.status).toBe(200)
        expect(await json(response)).toEqual({
          claimedScope: 'mable@hrc-runtime:primary-nova',
          sessionRef: CLAIMED_SESSION_REF,
          hostSessionId: 'hsid-mobile-new-session',
          runtimeId: 'rt-mobile-new-session',
          status: 'ready',
          replayed: false,
        })
        expect(starts).toHaveLength(1)
        expect(starts[0]).toMatchObject({
          baseSessionRef: BASE_SESSION_REF,
          conflictPolicy: 'suffix',
          summonIntent: 'implicit',
          idempotencyKey: deriveMobileSessionIdempotencyKey(REQUEST_ID),
          restartStyle: 'reuse_pty',
          runtimeIntent: {
            placement: {
              correlation: {
                sessionRef: {
                  scopeRef: BASE_SCOPE_REF,
                  laneRef: 'main',
                },
              },
            },
            harness: { provider: 'anthropic', interactive: true },
            execution: { preferredMode: 'headless' },
            presentation: { viewerWindow: 'console-e2e' },
          },
        })
        expect('hostSessionId' in (starts[0] as unknown as Record<string, unknown>)).toBe(false)
      },
      { hrcClient, runtimeResolver }
    )
  })

  /**
   * T-07603 removed the service-default window key. ACP no longer names a window
   * at all: HRC derives placement from scope shape, so a mobile `:primary` session
   * reaches the operator's interactive window with NO hint on the wire. The
   * explicit-hint case above is the complement — a client-supplied key is still
   * forwarded and still overrides the derived placement.
   */
  test('sends NO presentation hint when the client does not ask for a window', async () => {
    const starts: StartRuntimeRequest[] = []
    const hrcClient = createHrcClient({ onStart: (request) => starts.push(request) })

    await withWiredServer(
      async ({ request }) => {
        const response = await request({
          method: 'POST',
          path: '/v1/mobile/sessions',
          body: { agentId: 'mable', projectId: 'hrc-runtime', requestId: REQUEST_ID },
        })

        expect(response.status).toBe(200)
        expect(starts).toHaveLength(1)
        expect(starts[0]?.runtimeIntent).not.toHaveProperty('presentation')
      },
      { hrcClient, runtimeResolver }
    )
  })

  test.each(['primary', 'minisvc', 'minilab'] as const)(
    'sends the %s quick-pick lane to HRC as a suffix roster start',
    async (taskId) => {
      const starts: StartRuntimeRequest[] = []
      const hrcClient = createHrcClient({ onStart: (request) => starts.push(request) })
      await withWiredServer(
        async ({ request }) => {
          const response = await request({
            method: 'POST',
            path: '/v1/mobile/sessions',
            body: { agentId: 'mable', projectId: 'hrc-runtime', taskId, requestId: REQUEST_ID },
          })
          expect(response.status).toBe(200)
          expect(starts).toHaveLength(1)
          expect(starts[0]).toMatchObject({
            baseSessionRef: `agent:mable:project:hrc-runtime:task:${taskId}/lane:main`,
            conflictPolicy: 'suffix',
            summonIntent: 'implicit',
          })
          expect('sessionRef' in (starts[0] as unknown as Record<string, unknown>)).toBe(false)
        },
        { hrcClient, runtimeResolver }
      )
    }
  )

  test.each(['hrcdev', 'T-07301', 'primary-nova', 'codex-01a014ac.7723'] as const)(
    'sends the operator-typed %s scope to HRC as an exact reject start',
    async (taskId) => {
      const starts: StartRuntimeRequest[] = []
      const hrcClient = createHrcClient({ onStart: (request) => starts.push(request) })
      await withWiredServer(
        async ({ request, json }) => {
          const response = await request({
            method: 'POST',
            path: '/v1/mobile/sessions',
            body: { agentId: 'mable', projectId: 'hrc-runtime', taskId, requestId: REQUEST_ID },
          })
          const exactSessionRef = `agent:mable:project:hrc-runtime:task:${taskId}/lane:main`

          expect(response.status).toBe(200)
          expect(starts).toHaveLength(1)
          expect(starts[0]).toEqual({
            sessionRef: exactSessionRef,
            conflictPolicy: 'reject',
            summonIntent: 'implicit',
            idempotencyKey: deriveMobileSessionIdempotencyKey(REQUEST_ID),
            restartStyle: 'reuse_pty',
            runtimeIntent: expect.objectContaining({
              placement: expect.objectContaining({
                correlation: {
                  sessionRef: {
                    scopeRef: `agent:mable:project:hrc-runtime:task:${taskId}`,
                    laneRef: 'main',
                  },
                },
              }),
            }),
          })
          // The exact response DTO is the same shape as the roster one, built
          // from the scope HRC says it claimed.
          expect(await json(response)).toEqual({
            claimedScope: `mable@hrc-runtime:${taskId}`,
            sessionRef: exactSessionRef,
            hostSessionId: 'hsid-mobile-new-session',
            runtimeId: 'rt-mobile-new-session',
            status: 'ready',
            replayed: false,
          })
        },
        { hrcClient, runtimeResolver }
      )
    }
  )

  test('replays an exact start on the same logical press without a second scope', async () => {
    const starts: StartRuntimeRequest[] = []
    const hrcClient = createHrcClient({ onStart: (request) => starts.push(request) })

    await withWiredServer(
      async ({ request, json }) => {
        const body = {
          agentId: 'mable',
          projectId: 'hrc-runtime',
          taskId: 'hrcdev',
          requestId: REQUEST_ID,
        }
        const first = await request({ method: 'POST', path: '/v1/mobile/sessions', body })
        const retry = await request({ method: 'POST', path: '/v1/mobile/sessions', body })

        expect(first.status).toBe(200)
        expect(retry.status).toBe(200)
        expect(starts.map((start) => (start as { sessionRef?: string }).sessionRef)).toEqual([
          HRCDEV_SESSION_REF,
          HRCDEV_SESSION_REF,
        ])
        expect(starts[0]?.idempotencyKey).toBe(starts[1]?.idempotencyKey)
        expect(await json<{ claimedScope: string; replayed: boolean }>(first)).toMatchObject({
          claimedScope: 'mable@hrc-runtime:hrcdev',
          replayed: false,
        })
        expect(await json<{ claimedScope: string; replayed: boolean }>(retry)).toMatchObject({
          claimedScope: 'mable@hrc-runtime:hrcdev',
          replayed: true,
        })
      },
      { hrcClient, runtimeResolver }
    )
  })

  test('refuses an occupied exact scope with the stable 409 message', async () => {
    const hrcClient = createHrcClient({
      error: new HrcDomainError(
        HrcErrorCode.SESSION_SCOPE_OCCUPIED,
        'exact scope agent:mable:project:hrc-runtime:task:hrcdev is occupied',
        { scopeRef: 'agent:mable:project:hrc-runtime:task:hrcdev' }
      ),
    })

    await withWiredServer(
      async ({ request, json }) => {
        const response = await request({
          method: 'POST',
          path: '/v1/mobile/sessions',
          body: {
            agentId: 'mable',
            projectId: 'hrc-runtime',
            taskId: 'hrcdev',
            requestId: REQUEST_ID,
          },
        })

        expect(response.status).toBe(409)
        expect(await json(response)).toEqual({
          ok: false,
          requestId: REQUEST_ID,
          code: HrcErrorCode.SESSION_SCOPE_OCCUPIED,
          message: 'that scope is already open',
        })
      },
      { hrcClient, runtimeResolver }
    )
  })

  test('rejects a malformed task token before calling HRC', async () => {
    let starts = 0
    const hrcClient = createHrcClient({ onStart: () => starts++ })
    await withWiredServer(
      async ({ request, json }) => {
        const response = await request({
          method: 'POST',
          path: '/v1/mobile/sessions',
          body: {
            agentId: 'mable',
            projectId: 'hrc-runtime',
            taskId: 'minisvc nova',
            requestId: REQUEST_ID,
          },
        })
        expect(response.status).toBe(400)
        expect(
          await json<{ error: { code: string; details?: { field?: string } } }>(response)
        ).toMatchObject({
          error: { code: 'malformed_request', details: { field: 'taskId' } },
        })
        expect(starts).toBe(0)
      },
      { hrcClient, runtimeResolver }
    )
  })

  test('reuses the derived HRC key when the same logical press is retried', async () => {
    const starts: StartRuntimeRequest[] = []
    const hrcClient = createHrcClient({ onStart: (request) => starts.push(request) })

    await withWiredServer(
      async ({ request, json }) => {
        const body = { agentId: 'mable', projectId: 'hrc-runtime', requestId: REQUEST_ID }
        const first = await request({ method: 'POST', path: '/v1/mobile/sessions', body })
        const retry = await request({ method: 'POST', path: '/v1/mobile/sessions', body })

        expect(first.status).toBe(200)
        expect(retry.status).toBe(200)
        expect(starts).toHaveLength(2)
        expect(starts[0]?.idempotencyKey).toBe(starts[1]?.idempotencyKey)
        expect((await json<{ claimedScope: string }>(first)).claimedScope).toBe(
          'mable@hrc-runtime:primary-nova'
        )
        expect(await json<{ claimedScope: string; replayed: boolean }>(retry)).toMatchObject({
          claimedScope: 'mable@hrc-runtime:primary-nova',
          replayed: true,
        })
      },
      { hrcClient, runtimeResolver }
    )
  })

  test.each([
    [HrcErrorCode.SESSION_ROSTER_EXHAUSTED, 'too many open sessions'],
    [HrcErrorCode.IDEMPOTENCY_KEY_CONFLICT, 'requestId was reused for a different session request'],
    [HrcErrorCode.ROSTER_CLAIM_SUPERSEDED, 'try again'],
  ] as const)('maps %s to the mobile 409 response', async (code, message) => {
    const hrcClient = createHrcClient({
      error: new HrcDomainError(code, `HRC detail for ${code}`, { source: 'test' }),
    })
    const errorLog = spyOn(console, 'error').mockImplementation(() => {})

    try {
      await withWiredServer(
        async ({ request, json }) => {
          const response = await request({
            method: 'POST',
            path: '/v1/mobile/sessions',
            body: { agentId: 'mable', projectId: 'hrc-runtime', requestId: REQUEST_ID },
          })

          expect(response.status).toBe(409)
          expect(await json(response)).toEqual({
            ok: false,
            requestId: REQUEST_ID,
            code,
            message,
          })
          expect(errorLog).toHaveBeenCalledTimes(
            code === HrcErrorCode.IDEMPOTENCY_KEY_CONFLICT ? 1 : 0
          )
        },
        { hrcClient, runtimeResolver }
      )
    } finally {
      errorLog.mockRestore()
    }
  })

  test('rejects invalid scope tokens before calling HRC', async () => {
    let starts = 0
    const hrcClient = createHrcClient({ onStart: () => starts++ })

    await withWiredServer(
      async ({ request, json }) => {
        const response = await request({
          method: 'POST',
          path: '/v1/mobile/sessions',
          body: { agentId: 'mable:bad', projectId: 'hrc-runtime', requestId: REQUEST_ID },
        })

        expect(response.status).toBe(400)
        expect(await json<{ error: { code: string } }>(response)).toMatchObject({
          error: { code: 'malformed_request' },
        })
        expect(starts).toBe(0)
      },
      { hrcClient, runtimeResolver }
    )
  })
})
