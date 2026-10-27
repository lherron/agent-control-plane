import { describe, expect, test } from 'bun:test'

import type { AcpServerDeps } from '../src/index.js'
import { withWiredServer } from './fixtures/wired-server.js'

describe('POST /v1/sessions/resolve', () => {
  test.each<[string, Partial<AcpServerDeps>]>([
    ['the resolver reports no session', { sessionResolver: async () => undefined }],
    ['no resolver is wired', {}],
  ])(
    'unresolvable sessionRef returns 404 not_found naming the scope and lane when %s',
    async (_case, overrides) => {
      const scopeRef = 'agent:larry:project:demo:task:T-90002:role:implementer'
      await withWiredServer(async (fixture) => {
        const response = await fixture.request({
          method: 'POST',
          path: '/v1/sessions/resolve',
          body: { sessionRef: { scopeRef, laneRef: 'main' } },
        })
        const payload = await fixture.json<{
          error: { code: string; details?: Record<string, unknown> }
        }>(response)

        expect(response.status).toBe(404)
        expect(payload.error.code).toBe('not_found')
        expect(payload.error.details).toMatchObject({ scopeRef, laneRef: 'main' })
      }, overrides)
    }
  )
})
