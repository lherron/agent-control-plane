import { describe, expect, it } from 'bun:test'
import { HrcDomainError, HrcErrorCode } from 'hrc-core'
import type {
  DeliverLiteralBySelectorRequest,
  HrcRuntimeSnapshot,
  HrcSessionRecord,
  InterruptAppSessionRequest,
  ResolveSessionResponse,
  RuntimeActionResponse,
} from 'hrc-core'

import type { GatewayIosHrcClient } from '../input.js'
import { createGatewayIosFetchHandler, createGatewayIosRoutes } from '../routes.js'

function session(overrides: Partial<HrcSessionRecord> = {}): HrcSessionRecord {
  return {
    hostSessionId: 'host-001',
    scopeRef: 'agent:cody:project:agent-spaces',
    laneRef: 'main',
    generation: 3,
    status: 'active',
    createdAt: '2026-04-29T12:00:00.000Z',
    updatedAt: '2026-04-29T12:00:00.000Z',
    ancestorScopeRefs: [],
    lastAppliedIntentJson: {
      placement: { kind: 'test' },
      harness: { provider: 'anthropic', interactive: true },
    },
    ...overrides,
  }
}

function resolved(overrides: Partial<ResolveSessionResponse> = {}): ResolveSessionResponse {
  const record = overrides.session ?? session()
  return {
    hostSessionId: record.hostSessionId,
    generation: record.generation,
    created: false,
    session: record,
    ...overrides,
  }
}

function runtime(overrides: Partial<HrcRuntimeSnapshot> = {}): HrcRuntimeSnapshot {
  return {
    runtimeId: 'rt-001',
    hostSessionId: 'host-001',
    scopeRef: 'agent:cody:project:agent-spaces',
    laneRef: 'main',
    generation: 3,
    transport: 'tmux',
    harness: 'claude-code',
    provider: 'anthropic',
    status: 'running',
    supportsInflightInput: false,
    adopted: false,
    ...overrides,
  }
}

function request(path: string, body: unknown): Request {
  return new Request(`http://ios.test${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
}

async function body(response: Response): Promise<Record<string, unknown>> {
  return (await response.json()) as Record<string, unknown>
}

describe('gateway-ios input routes', () => {
  it('registers POST /v1/input and POST /v1/interrupt', () => {
    const routes = createGatewayIosRoutes({ hrcClient: {} as GatewayIosHrcClient })
    expect(routes.map((route) => `${route.method} ${route.path}`)).toContain('POST /v1/input')
    expect(routes.map((route) => `${route.method} ${route.path}`)).toContain('POST /v1/interrupt')
  })

  it('POST /v1/input rejects headless sessions', async () => {
    let delivered = false
    const client = {
      resolveSession: async () =>
        resolved({
          session: session({
            lastAppliedIntentJson: {
              placement: { kind: 'test' },
              harness: { provider: 'anthropic', interactive: false },
              execution: { preferredMode: 'headless' },
            },
          }),
        }),
      deliverLiteralBySelector: async () => {
        delivered = true
        return { delivered: true, sessionRef: 'unused', hostSessionId: 'unused', generation: 0 }
      },
      listRuntimes: async () => [],
      interrupt: async () => ({ interrupted: true }) as unknown as RuntimeActionResponse,
    } satisfies GatewayIosHrcClient

    const response = await createGatewayIosFetchHandler({ hrcClient: client })(
      request('/v1/input', {
        sessionRef: 'agent:cody:project:agent-spaces/lane:main',
        clientInputId: 'input-001',
        text: 'continue',
        enter: true,
        fences: { expectedHostSessionId: 'host-001', expectedGeneration: 3 },
      })
    )

    expect(response.status).toBe(400)
    expect(await body(response)).toEqual({ ok: false, code: 'session_not_interactive' })
    expect(delivered).toBe(false)
  })

  it('POST /v1/input sends literal input by selector and returns an ISO ack', async () => {
    const calls: DeliverLiteralBySelectorRequest[] = []
    const client = {
      resolveSession: async () => resolved(),
      deliverLiteralBySelector: async (payload) => {
        calls.push(payload)
        return {
          delivered: true,
          sessionRef: payload.selector.sessionRef,
          hostSessionId: 'host-001',
          generation: 3,
          runtimeId: 'rt-001',
        }
      },
      listRuntimes: async () => [],
      interrupt: async () => ({ interrupted: true }) as unknown as RuntimeActionResponse,
    } satisfies GatewayIosHrcClient

    const response = await createGatewayIosFetchHandler({ hrcClient: client })(
      request('/v1/input', {
        sessionRef: 'agent:cody:project:agent-spaces/lane:main',
        clientInputId: 'input-002',
        text: 'continue',
        enter: true,
        fences: { expectedHostSessionId: 'host-001', expectedGeneration: 3 },
      })
    )
    const payload = await body(response)

    expect(response.status).toBe(200)
    expect(calls).toEqual([
      {
        selector: { sessionRef: 'agent:cody:project:agent-spaces/lane:main' },
        text: 'continue',
        enter: true,
        fences: { expectedHostSessionId: 'host-001', expectedGeneration: 3 },
      },
    ])
    expect(payload.ok).toBe(true)
    expect(payload.clientInputId).toBe('input-002')
    expect(typeof payload.acceptedAt).toBe('string')
    expect(Number.isNaN(Date.parse(payload.acceptedAt as string))).toBe(false)
  })

  it('POST /v1/input rejects stale fences before delivery', async () => {
    let delivered = false
    const client = {
      resolveSession: async () => resolved(),
      deliverLiteralBySelector: async () => {
        delivered = true
        return { delivered: true, sessionRef: 'unused', hostSessionId: 'unused', generation: 0 }
      },
      listRuntimes: async () => [],
      interrupt: async () => ({ interrupted: true }) as unknown as RuntimeActionResponse,
    } satisfies GatewayIosHrcClient

    const response = await createGatewayIosFetchHandler({ hrcClient: client })(
      request('/v1/input', {
        sessionRef: 'agent:cody:project:agent-spaces/lane:main',
        clientInputId: 'input-003',
        text: 'continue',
        enter: true,
        fences: { expectedHostSessionId: 'host-001', expectedGeneration: 2 },
      })
    )

    expect(response.status).toBe(409)
    expect((await body(response)).code).toBe(HrcErrorCode.STALE_CONTEXT)
    expect(delivered).toBe(false)
  })

  it('POST /v1/interrupt routes runtime-bound sessions to /v1/interrupt', async () => {
    const calls: Array<{ method: string; runtimeId: string }> = []
    const client = {
      resolveSession: async () => resolved(),
      deliverLiteralBySelector: async () => {
        throw new Error('unused')
      },
      listRuntimes: async () => [runtime({ runtimeId: 'rt-interrupt' })],
      interrupt: async (runtimeId) => {
        calls.push({ method: 'interrupt', runtimeId })
        return { interrupted: true } as unknown as RuntimeActionResponse
      },
    } satisfies GatewayIosHrcClient

    const response = await createGatewayIosFetchHandler({ hrcClient: client })(
      request('/v1/interrupt', {
        sessionRef: 'agent:cody:project:agent-spaces/lane:main',
        clientInputId: 'input-004',
        fences: { expectedHostSessionId: 'host-001', expectedGeneration: 3 },
      })
    )

    expect(response.status).toBe(200)
    expect(await body(response)).toEqual({ ok: true, clientInputId: 'input-004' })
    expect(calls).toEqual([{ method: 'interrupt', runtimeId: 'rt-interrupt' }])
  })

  it('POST /v1/interrupt routes app-managed sessions to /v1/app-sessions/interrupt', async () => {
    const calls: Array<{ path: string; body: InterruptAppSessionRequest }> = []
    const client = {
      resolveSession: async () =>
        resolved({
          session: session({
            scopeRef: 'app:ios-client',
            laneRef: 'command-001',
          }),
        }),
      deliverLiteralBySelector: async () => {
        throw new Error('unused')
      },
      listRuntimes: async () => {
        throw new Error('runtime-bound path should not be used')
      },
      interrupt: async () => {
        throw new Error('runtime-bound path should not be used')
      },
      postJson: async <T>(path: string, payload: unknown): Promise<T> => {
        calls.push({ path, body: payload as InterruptAppSessionRequest })
        return { interrupted: true } as T
      },
    } satisfies GatewayIosHrcClient

    const response = await createGatewayIosFetchHandler({ hrcClient: client })(
      request('/v1/interrupt', {
        sessionRef: 'app:ios-client/lane:command-001',
        clientInputId: 'input-005',
        fences: { expectedHostSessionId: 'host-001', expectedGeneration: 3 },
      })
    )

    expect(response.status).toBe(200)
    expect(await body(response)).toEqual({ ok: true, clientInputId: 'input-005' })
    expect(calls).toEqual([
      {
        path: '/v1/app-sessions/interrupt',
        body: { selector: { appId: 'ios-client', appSessionKey: 'command-001' } },
      },
    ])
  })

  it('maps HRC errors to gateway error bodies', async () => {
    const client = {
      resolveSession: async () => {
        throw new HrcDomainError(HrcErrorCode.RUNTIME_UNAVAILABLE, 'runtime unavailable')
      },
      deliverLiteralBySelector: async () => {
        throw new Error('unused')
      },
      listRuntimes: async () => [],
      interrupt: async () => ({ interrupted: true }) as unknown as RuntimeActionResponse,
    } satisfies GatewayIosHrcClient

    const response = await createGatewayIosFetchHandler({ hrcClient: client })(
      request('/v1/input', {
        sessionRef: 'agent:cody:project:agent-spaces/lane:main',
        clientInputId: 'input-006',
        text: 'continue',
        enter: true,
        fences: { expectedHostSessionId: 'host-001', expectedGeneration: 3 },
      })
    )

    expect(response.status).toBe(503)
    expect(await body(response)).toEqual({
      ok: false,
      code: HrcErrorCode.RUNTIME_UNAVAILABLE,
      message: 'runtime unavailable',
    })
  })
})
