import { describe, expect, test } from 'bun:test'

import { withWiredServer } from './fixtures/wired-server.js'

describe('POST /v1/runtime/resolve', () => {
  test('delegates to runtimeResolver when provided', async () => {
    await withWiredServer(
      async (fixture) => {
        const response = await fixture.request({
          method: 'POST',
          path: '/v1/runtime/resolve',
          body: {
            sessionRef: {
              scopeRef: 'agent:larry:project:demo:task:T-80001:role:implementer',
              laneRef: 'main',
            },
          },
        })
        const payload = await fixture.json<{ placement: { agentRoot: string } }>(response)

        expect(response.status).toBe(200)
        expect(payload.placement.agentRoot).toBe('/tmp/runtime-resolver')
      },
      {
        runtimeResolver: async () => ({ agentRoot: '/tmp/runtime-resolver' }),
      }
    )
  })

  test('falls back to agentRootResolver when runtimeResolver is absent', async () => {
    await withWiredServer(
      async (fixture) => {
        const response = await fixture.request({
          method: 'POST',
          path: '/v1/runtime/resolve',
          body: {
            sessionRef: {
              scopeRef: 'agent:curly:project:demo:task:T-80002:role:tester',
              laneRef: 'main',
            },
          },
        })
        const payload = await fixture.json<{ placement: { agentRoot: string } }>(response)

        expect(response.status).toBe(200)
        expect(payload.placement.agentRoot).toBe('/tmp/agents/curly')
      },
      {
        agentRootResolver: async ({ agentId }) => `/tmp/agents/${agentId}`,
      }
    )
  })

  test('returns 404 when neither runtimeResolver nor agentRootResolver resolve placement', async () => {
    await withWiredServer(async (fixture) => {
      const response = await fixture.request({
        method: 'POST',
        path: '/v1/runtime/resolve',
        body: {
          sessionRef: {
            scopeRef: 'agent:curly:project:demo:task:T-80003:role:tester',
            laneRef: 'main',
          },
        },
      })

      expect(response.status).toBe(404)
    })
  })

  test('returns 400 for invalid session refs', async () => {
    await withWiredServer(async (fixture) => {
      const response = await fixture.request({
        method: 'POST',
        path: '/v1/runtime/resolve',
        body: {
          sessionRef: { scopeRef: 'not-a-scope-ref', laneRef: 'main' },
        },
      })

      expect(response.status).toBe(400)
    })
  })
})
