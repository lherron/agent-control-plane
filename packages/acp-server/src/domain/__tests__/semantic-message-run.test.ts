import { describe, expect, test } from 'bun:test'

import { withWiredServer } from '../../../test/fixtures/wired-server.js'

describe('semantic-message run terminal projection', () => {
  test('GET /v1/runs/:runId projects a federated-message terminal failure as a typed failure block', async () => {
    await withWiredServer(async (fixture) => {
      const created = fixture.runStore.createRun({
        sessionRef: {
          scopeRef: 'agent:scribe:project:hrc-runtime:task:T-06805-t4-failure',
          laneRef: 'main',
        },
        status: 'failed',
        metadata: {
          meta: {
            hrcSemanticMessage: {
              requestMessageId: 'msg-t4-failure',
              rootMessageId: 'msg-t4-failure',
              afterSeq: 6805,
              terminal: {
                state: 'failed',
                error: {
                  code: 'runtime_unavailable',
                  message: 'max3 is unreachable',
                  reason: 'peer_unreachable',
                  retryable: true,
                  homeNodeId: 'max3',
                },
              },
            },
          },
        },
      })
      fixture.runStore.updateRun(created.runId, {
        transport: 'federated-message',
        errorCode: 'runtime_unavailable',
        errorMessage: 'max3 is unreachable',
      })

      const response = await fixture.request({ method: 'GET', path: `/v1/runs/${created.runId}` })

      expect(response.status).toBe(200)
      const body = await fixture.json<{ run: Record<string, unknown> }>(response)
      expect(body.run).toMatchObject({
        runId: created.runId,
        status: 'failed',
        errorCode: 'runtime_unavailable',
        failure: {
          code: 'runtime_unavailable',
          message: 'max3 is unreachable',
          reason: 'peer_unreachable',
          retryable: true,
          homeNodeId: 'max3',
        },
      })
    })
  })
})
