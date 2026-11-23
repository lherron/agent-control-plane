import { describe, expect, spyOn, test } from 'bun:test'
import { HrcDomainError, HrcErrorCode } from 'hrc-core'
import { deriveMobileSessionIdempotencyKey } from '../src/handlers/mobile-sessions-create.js'
import {
  BASE_SCOPE_REF,
  BASE_SESSION_REF,
  CLAIMED_SESSION_REF,
  REQUEST_ID,
  createMobileSessionHrcClient,
  withMobileSessionServer,
} from './fixtures/mobile-session-creation.js'

const HRCDEV_SESSION_REF = 'agent:mable:project:hrc-runtime:task:hrcdev/lane:main'

describe('POST /v1/mobile/sessions', () => {
  test('passes only the base scope to HRC and projects the claimed scope prominently', async () => {
    const { client, starts } = createMobileSessionHrcClient()

    await withMobileSessionServer(async ({ post, json }) => {
      const response = await post({ viewerWindow: 'console-e2e' })

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
    }, client)
  })

  /**
   * T-07603 removed the service-default window key. ACP no longer names a window
   * at all: HRC derives placement from scope shape, so a mobile `:primary` session
   * reaches the operator's interactive window with NO hint on the wire. The
   * explicit-hint case above is the complement — a client-supplied key is still
   * forwarded and still overrides the derived placement.
   */
  test('sends NO presentation hint when the client does not ask for a window', async () => {
    const { client, starts } = createMobileSessionHrcClient()

    await withMobileSessionServer(async ({ post }) => {
      const response = await post()

      expect(response.status).toBe(200)
      expect(starts).toHaveLength(1)
      expect(starts[0]?.runtimeIntent).not.toHaveProperty('presentation')
    }, client)
  })

  test.each(['primary', 'minisvc', ' minisvc '] as const)(
    'sends the %s quick-pick lane to HRC as a suffix roster start',
    async (rawTaskId) => {
      const taskId = rawTaskId.trim()
      const { client, starts } = createMobileSessionHrcClient()
      await withMobileSessionServer(async ({ post }) => {
        const response = await post({ taskId: rawTaskId })
        expect(response.status).toBe(200)
        expect(starts).toHaveLength(1)
        expect(starts[0]).toMatchObject({
          baseSessionRef: `agent:mable:project:hrc-runtime:task:${taskId}/lane:main`,
          conflictPolicy: 'suffix',
          summonIntent: 'implicit',
        })
        expect('sessionRef' in (starts[0] as unknown as Record<string, unknown>)).toBe(false)
        expect(starts[0]).not.toHaveProperty('hostSessionId')
        expect(starts[0]).not.toHaveProperty('nodeId')
      }, client)
    }
  )

  // Any task id inside the canonical scope-token grammar (up to 64 chars) is an
  // exact start; surrounding whitespace is trimmed before the scope is built.
  test.each([
    'hrcdev',
    'T-07301',
    'primary-nova',
    'codex-01a014ac.7723',
    'a'.repeat(64),
    ' hrcdev ',
  ])('sends the operator-typed %s scope to HRC as an exact reject start', async (rawTaskId) => {
    const taskId = rawTaskId.trim()
    const { client, starts } = createMobileSessionHrcClient()
    await withMobileSessionServer(async ({ post, json }) => {
      const response = await post({ taskId: rawTaskId })
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
    }, client)
  })

  test.each([
    ['suffix roster', undefined, CLAIMED_SESSION_REF, 'mable@hrc-runtime:primary-nova'],
    ['exact', 'hrcdev', HRCDEV_SESSION_REF, 'mable@hrc-runtime:hrcdev'],
  ] as const)(
    'replays a %s start on the same logical press with the same derived key and claimed scope',
    async (_label, taskId, claimedSessionRef, claimedScope) => {
      const { client, starts } = createMobileSessionHrcClient()

      await withMobileSessionServer(async ({ post, json }) => {
        const body = taskId === undefined ? {} : { taskId }
        const first = await post(body)
        const retry = await post(body)
        const nextPress = await post({ ...body, requestId: 'ios-press-next' })

        expect([first.status, retry.status, nextPress.status]).toEqual([200, 200, 200])
        expect(starts).toHaveLength(3)
        const [firstKey, retryKey, nextKey] = starts.map((start) => start.idempotencyKey)
        expect(retryKey).toBe(firstKey)
        // A different press is a different logical request.
        expect(nextKey).not.toBe(firstKey)
        // Namespaced, versioned, and opaque: the client requestId never reaches HRC.
        expect(firstKey).toMatch(/^acp-mobile-session:v1:[a-f0-9]{64}$/)
        expect(firstKey).not.toContain(REQUEST_ID)
        if (taskId !== undefined) {
          expect(
            starts.slice(0, 2).map((start) => (start as { sessionRef?: string }).sessionRef)
          ).toEqual([claimedSessionRef, claimedSessionRef])
        }
        expect(
          await json<{ sessionRef: string; claimedScope: string; replayed: boolean }>(first)
        ).toMatchObject({
          sessionRef: claimedSessionRef,
          claimedScope,
          replayed: false,
        })
        expect(
          await json<{ sessionRef: string; claimedScope: string; replayed: boolean }>(retry)
        ).toMatchObject({
          sessionRef: claimedSessionRef,
          claimedScope,
          replayed: true,
        })
      }, client)
    }
  )

  test('refuses an occupied exact scope with the stable 409 message', async () => {
    const { client } = createMobileSessionHrcClient({
      startError: new HrcDomainError(
        HrcErrorCode.SESSION_SCOPE_OCCUPIED,
        'exact scope agent:mable:project:hrc-runtime:task:hrcdev is occupied',
        { scopeRef: 'agent:mable:project:hrc-runtime:task:hrcdev' }
      ),
    })

    await withMobileSessionServer(async ({ post, json }) => {
      const response = await post({ taskId: 'hrcdev' })

      expect(response.status).toBe(409)
      expect(await json(response)).toEqual({
        ok: false,
        requestId: REQUEST_ID,
        code: HrcErrorCode.SESSION_SCOPE_OCCUPIED,
        message: 'that scope is already open',
      })
    }, client)
  })

  test.each([
    ['minisvc nova', undefined],
    ['bad:task', undefined],
    ['bad/task', undefined],
    ['a'.repeat(65), undefined],
    ['   ', 'taskId must be a non-empty string'],
    [7, 'taskId must be a non-empty string'],
  ] as const)('rejects the malformed task token %p before calling HRC', async (taskId, message) => {
    const { client, starts } = createMobileSessionHrcClient()
    await withMobileSessionServer(async ({ post, json }) => {
      const response = await post({ taskId })
      expect(response.status).toBe(400)
      const body = await json<{
        error: { code: string; message: string; details?: { field?: string } }
      }>(response)
      expect(body).toMatchObject({
        error: { code: 'malformed_request', details: { field: 'taskId' } },
      })
      if (message !== undefined) expect(body.error.message).toContain(message)
      expect(starts.length).toBe(0)
    }, client)
  })

  test.each([
    [HrcErrorCode.SESSION_ROSTER_EXHAUSTED, 'too many open sessions'],
    [HrcErrorCode.IDEMPOTENCY_KEY_CONFLICT, 'requestId was reused for a different session request'],
    [HrcErrorCode.ROSTER_CLAIM_SUPERSEDED, 'try again'],
  ] as const)('maps %s to the mobile 409 response', async (code, message) => {
    const { client } = createMobileSessionHrcClient({
      startError: new HrcDomainError(code, `HRC detail for ${code}`, { source: 'test' }),
    })
    const errorLog = spyOn(console, 'error').mockImplementation(() => {})

    try {
      await withMobileSessionServer(async ({ post, json }) => {
        const response = await post()

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
      }, client)
    } finally {
      errorLog.mockRestore()
    }
  })

  test.each([
    ['agentId', { agentId: 'mable:bad', projectId: 'hrc-runtime' }, 'After "agent:<agentId>"'],
    ['projectId', { agentId: 'mable', projectId: 'x/y' }, 'projectId contains invalid characters'],
  ] as const)(
    'rejects an invalid %s scope token before calling HRC',
    async (_field, scope, reason) => {
      const { client, starts } = createMobileSessionHrcClient()

      await withMobileSessionServer(async ({ post, json }) => {
        const response = await post(scope)

        expect(response.status).toBe(400)
        const body = await json<{
          error: { code: string; message: string; details?: Record<string, unknown> }
        }>(response)
        expect(body.error.code).toBe('malformed_request')
        expect(body.error.message).toContain(reason)
        expect(starts.length).toBe(0)
      }, client)
    }
  )
})
