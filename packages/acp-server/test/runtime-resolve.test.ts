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
        const payload = await fixture.json<{
          placement: { agentRoot: string; projectRoot: string; cwd: string }
        }>(response)

        expect(response.status).toBe(200)
        expect(payload.placement.agentRoot).toBe('/tmp/runtime-resolver')
        expect(payload.placement.projectRoot).toBe('/tmp/demo')
        expect(payload.placement.cwd).toBe('/tmp/demo')
      },
      {
        runtimeResolver: async () => ({
          agentRoot: '/tmp/runtime-resolver',
          projectRoot: '/tmp/demo',
          cwd: '/tmp/runtime-resolver',
        }),
      }
    )
  })

  test('returns 404 instead of an agent-home placement when a project root is unresolved', async () => {
    await withWiredServer(
      async (fixture) => {
        const response = await fixture.request({
          method: 'POST',
          path: '/v1/runtime/resolve',
          body: {
            sessionRef: {
              scopeRef: 'agent:larry:project:missing:task:T-80002:role:implementer',
              laneRef: 'main',
            },
          },
        })

        expect(response.status).toBe(404)
        const payload = await fixture.json<{ error: { message: string } }>(response)
        expect(payload.error.message).toContain('project root not found')
      },
      {
        runtimeResolver: async () => ({
          agentRoot: '/tmp/runtime-resolver',
          cwd: '/tmp/runtime-resolver',
        }),
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
