import { describe, expect, spyOn, test } from 'bun:test'

import { HrcDomainError, HrcErrorCode } from 'hrc-core'
import type { StartRuntimeRequest, StartRuntimeResponse } from 'hrc-sdk'
import type { AcpRuntimePlacement } from '../src/deps.js'
import type { AcpHrcClient } from '../src/deps.js'
import {
  deriveMobileSessionIdempotencyKey,
  resolveConfiguredMobileViewerWindow,
  resolveMobileViewerWindow,
} from '../src/handlers/mobile-sessions-create.js'

import { withWiredServer } from './fixtures/wired-server.js'

const BASE_SCOPE_REF = 'agent:mable:project:hrc-runtime:task:primary'
const CLAIMED_SCOPE_REF = 'agent:mable:project:hrc-runtime:task:primary-nova'
const BASE_SESSION_REF = `${BASE_SCOPE_REF}/lane:main`
const CLAIMED_SESSION_REF = `${CLAIMED_SCOPE_REF}/lane:main`
const REQUEST_ID = 'ios-press-01879d8f'
const TEST_AGENT_ROOT = new URL('./fixtures/mobile-agent/', import.meta.url).pathname

function startedResponse(replayed = false): StartRuntimeResponse {
  return {
    runtimeId: 'rt-mobile-new-session',
    hostSessionId: 'hsid-mobile-new-session',
    transport: 'headless',
    status: 'ready',
    supportsInFlightInput: false,
    claim: {
      slot: 'primary-nova',
      scopeRef: CLAIMED_SCOPE_REF,
      sessionRef: CLAIMED_SESSION_REF,
      hostSessionId: 'hsid-mobile-new-session',
      idempotencyKey: deriveMobileSessionIdempotencyKey(REQUEST_ID),
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
      return startedResponse(calls++ > 0)
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

  test('uses request override, configured default, then console fallback', () => {
    expect(resolveMobileViewerWindow('operator-window', 'console-alt')).toBe('operator-window')
    expect(resolveMobileViewerWindow(undefined, 'console-alt')).toBe('console-alt')
    expect(resolveConfiguredMobileViewerWindow({})).toBe('console')
    expect(resolveConfiguredMobileViewerWindow({ ACP_MOBILE_VIEWER_WINDOW: 'console-alt' })).toBe(
      'console-alt'
    )
    expect(resolveConfiguredMobileViewerWindow({ ACP_MOBILE_VIEWER_WINDOW: '  ' })).toBe('console')
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
