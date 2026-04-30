import { describe, expect, it } from 'bun:test'
import type { HealthResponse, StatusResponse } from 'hrc-core'
import type { HrcClient } from 'hrc-sdk'
import { handleHealth } from '../health.js'

// ---------------------------------------------------------------------------
// Fake HrcClient with controllable responses
// ---------------------------------------------------------------------------

type FakeHrcClientOptions = {
  healthResponse?: HealthResponse
  statusResponse?: Partial<StatusResponse>
  healthError?: Error
  statusError?: Error
}

function createFakeHrcClient(options: FakeHrcClientOptions = {}): HrcClient {
  return {
    getHealth: async () => {
      if (options.healthError) throw options.healthError
      return options.healthResponse ?? { ok: true }
    },
    getStatus: async () => {
      if (options.statusError) throw options.statusError
      return {
        ok: true as const,
        uptime: 12345,
        startedAt: '2026-04-29T00:00:00Z',
        socketPath: '/tmp/hrc.sock',
        dbPath: '/tmp/hrc.db',
        sessionCount: 3,
        runtimeCount: 2,
        apiVersion: 'v1',
        capabilities: {
          semanticCore: {
            sessions: true,
            ensureRuntime: true,
            dispatchTurn: true,
            inFlightInput: true,
            capture: true,
            attach: true,
            clearContext: true,
          },
          platform: {
            appOwnedSessions: true,
            appHarnessSessions: true,
            commandSessions: true,
            literalInput: true,
            surfaceBindings: true,
            legacyLocalBridges: [],
          },
          bridgeDelivery: {
            actualPtyInjection: true,
            enter: true,
            oobSuffix: false,
          },
          backend: {},
        },
        sessions: [],
        ...options.statusResponse,
      } as StatusResponse
    },
  } as unknown as HrcClient
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('GET /v1/health', () => {
  it('returns ok:true with gateway and hrc fields when HRC is reachable', async () => {
    const client = createFakeHrcClient()
    const result = await handleHealth(client, 'ios-test')

    expect(result.ok).toBe(true)
    expect(result.gatewayId).toBe('ios-test')
    expect(result.apiVersion).toBe('v1')
    expect(result.hrc.ok).toBe(true)
    expect(result.hrc.apiVersion).toBe('v1')
    expect(result.hrc.capabilities).toBeDefined()
    expect(result.hrc.capabilities!.sessions).toBe(true)
    expect(result.hrc.capabilities!.events).toBe(true)
    expect(result.hrc.capabilities!.messages).toBe(true)
    expect(result.hrc.capabilities!.literalInput).toBe(true)
    expect(result.hrc.capabilities!.appOwnedSessions).toBe(true)
  })

  it('populates capabilities from HRC status feature flags', async () => {
    const client = createFakeHrcClient({
      statusResponse: {
        capabilities: {
          semanticCore: {
            sessions: false,
            ensureRuntime: true,
            dispatchTurn: true,
            inFlightInput: true,
            capture: true,
            attach: true,
            clearContext: true,
          },
          platform: {
            appOwnedSessions: false,
            appHarnessSessions: false,
            commandSessions: false,
            literalInput: false,
            surfaceBindings: false,
            legacyLocalBridges: [],
          },
          bridgeDelivery: {
            actualPtyInjection: false,
            enter: false,
            oobSuffix: false,
          },
          backend: {},
        },
      },
    })

    const result = await handleHealth(client, 'ios-flags')

    expect(result.hrc.ok).toBe(true)
    expect(result.hrc.capabilities!.sessions).toBe(false)
    expect(result.hrc.capabilities!.literalInput).toBe(false)
    expect(result.hrc.capabilities!.appOwnedSessions).toBe(false)
  })

  it('returns hrc.ok:false with error when HRC is unreachable', async () => {
    const client = createFakeHrcClient({
      healthError: new Error('Connection refused'),
    })

    const result = await handleHealth(client, 'ios-down')

    expect(result.ok).toBe(true)
    expect(result.gatewayId).toBe('ios-down')
    expect(result.apiVersion).toBe('v1')
    expect(result.hrc.ok).toBe(false)
    expect(result.hrc.error).toBe('Connection refused')
    expect(result.hrc.capabilities).toBeUndefined()
  })

  it('returns hrc.ok:false when status call fails', async () => {
    const client = createFakeHrcClient({
      statusError: new Error('Status endpoint not available'),
    })

    const result = await handleHealth(client, 'ios-partial')

    expect(result.ok).toBe(true)
    expect(result.hrc.ok).toBe(false)
    expect(result.hrc.error).toBe('Status endpoint not available')
  })

  it('preserves gateway fields regardless of HRC state', async () => {
    const failClient = createFakeHrcClient({
      healthError: new Error('dead'),
    })

    const result = await handleHealth(failClient, 'my-gateway')

    // Gateway is always ok (it's up if this code is running)
    expect(result.ok).toBe(true)
    expect(result.gatewayId).toBe('my-gateway')
    expect(result.apiVersion).toBe('v1')
  })
})
