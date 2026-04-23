import { describe, expect, test } from 'bun:test'

import { resolveLauncherDeps } from '../src/cli.js'
import type { AcpHrcClient } from '../src/index.js'
import { withWiredServer } from './fixtures/wired-server.js'

function createHrcClientDouble(overrides: Partial<AcpHrcClient> = {}): AcpHrcClient {
  const notImplemented = (name: string) => async () => {
    throw new Error(`${name} not implemented`)
  }

  return {
    resolveSession:
      overrides.resolveSession ??
      (notImplemented('resolveSession') as unknown as AcpHrcClient['resolveSession']),
    listSessions:
      overrides.listSessions ??
      (notImplemented('listSessions') as unknown as AcpHrcClient['listSessions']),
    getSession:
      overrides.getSession ??
      (notImplemented('getSession') as unknown as AcpHrcClient['getSession']),
    clearContext:
      overrides.clearContext ??
      (notImplemented('clearContext') as unknown as AcpHrcClient['clearContext']),
    listRuntimes:
      overrides.listRuntimes ??
      (notImplemented('listRuntimes') as unknown as AcpHrcClient['listRuntimes']),
    capture: overrides.capture ?? (notImplemented('capture') as unknown as AcpHrcClient['capture']),
    getAttachDescriptor:
      overrides.getAttachDescriptor ??
      (notImplemented('getAttachDescriptor') as unknown as AcpHrcClient['getAttachDescriptor']),
    interrupt:
      overrides.interrupt ?? (notImplemented('interrupt') as unknown as AcpHrcClient['interrupt']),
    terminate:
      overrides.terminate ?? (notImplemented('terminate') as unknown as AcpHrcClient['terminate']),
    watch:
      overrides.watch ??
      // biome-ignore lint/correctness/useYield: test double that throws on use
      (async function* () {
        throw new Error('watch not implemented')
      } as unknown as AcpHrcClient['watch']),
  }
}

describe('POST /v1/sessions/resolve production wiring', () => {
  test('ACP_REAL_HRC_LAUNCHER wires sessionResolver through the HRC client', async () => {
    const calls: unknown[] = []
    const hrcClient = createHrcClientDouble({
      resolveSession: async (request) => {
        calls.push(request)
        return {
          hostSessionId: 'hsid-prod-resolve-001',
          generation: 7,
          created: false,
          session: {
            hostSessionId: 'hsid-prod-resolve-001',
            scopeRef: 'agent:larry:project:demo:task:T-91001:role:implementer',
            laneRef: 'main',
            generation: 7,
            status: 'active',
            createdAt: '2026-04-23T00:00:00.000Z',
            updatedAt: '2026-04-23T00:00:00.000Z',
            ancestorScopeRefs: [],
          },
        }
      },
    })

    const launcherDeps = resolveLauncherDeps(
      { ACP_REAL_HRC_LAUNCHER: '1' },
      '/tmp/acp-server-cli',
      {
        createHrcClient: () => hrcClient,
      }
    )

    await withWiredServer(async (fixture) => {
      const response = await fixture.request({
        method: 'POST',
        path: '/v1/sessions/resolve',
        body: {
          sessionRef: {
            scopeRef: 'agent:larry:project:demo:task:T-91001:role:implementer',
            laneRef: 'main',
          },
        },
      })
      const payload = await fixture.json<{ sessionId: string }>(response)

      expect(response.status).toBe(200)
      expect(payload).toEqual({ sessionId: 'hsid-prod-resolve-001' })
      expect(calls).toEqual([
        {
          sessionRef: 'agent:larry:project:demo:task:T-91001:role:implementer/lane:main',
        },
      ])
    }, launcherDeps)
  })
})
