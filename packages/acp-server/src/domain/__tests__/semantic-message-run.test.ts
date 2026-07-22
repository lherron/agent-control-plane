import { describe, expect, test } from 'bun:test'

import type { StoredRun } from '../run-store.js'
import {
  normalizeSemanticMessageDeliveryFailure,
  projectSemanticMessageRun,
} from '../semantic-message-run.js'

describe('semantic-message run terminal projection', () => {
  test('maps retryable delivery failures to runtime_unavailable without dropping cause detail', () => {
    expect(
      normalizeSemanticMessageDeliveryFailure({
        errorCode: 'peer_delivery_failed',
        errorMessage: 'max3 is unreachable',
        errorReason: 'peer_unreachable',
        retryable: true,
        homeNodeId: 'max3',
      })
    ).toEqual({
      code: 'runtime_unavailable',
      message: 'max3 is unreachable',
      reason: 'peer_unreachable',
      retryable: true,
      homeNodeId: 'max3',
    })
  })

  test('projects the durable typed failure onto the GET run resource', () => {
    const run: StoredRun = {
      runId: 'run-t4-failure',
      scopeRef: 'agent:scribe:project:hrc-runtime:task:T-06805-t4-failure',
      laneRef: 'main',
      actor: { kind: 'system', id: 'acp-local' },
      status: 'failed',
      createdAt: '2026-07-22T22:30:00.000Z',
      updatedAt: '2026-07-22T22:31:00.000Z',
      transport: 'federated-message',
      errorCode: 'runtime_unavailable',
      errorMessage: 'max3 is unreachable',
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
    }

    expect(projectSemanticMessageRun(run)).toMatchObject({
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
