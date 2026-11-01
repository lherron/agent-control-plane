import { expect, test } from 'bun:test'

import { federatedLiveRuntimes } from '../src/federated-runtimes.js'

test('projects exact-scope live runtimes per node and names unanswered peers (T-12214)', async () => {
  const scope = 'agent:stella:project:hrc-ios:task:primary-pulsar-2'
  let filter: unknown
  const client = {
    async listFederatedRuntimes(input: unknown) {
      filter = input
      return {
        localNodeId: 'svc',
        generatedAt: '2026-11-01T05:34:45.000Z',
        nodes: [
          // A prefix sibling and a history row are not this scope live here.
          {
            nodeId: 'svc',
            state: 'answered',
            runtimes: [
              { scopeRef: `${scope}-old`, status: 'ready' },
              { scopeRef: scope, status: 'terminated' },
            ],
          },
          { nodeId: 'max3', state: 'answered', runtimes: [{ scopeRef: scope, status: 'busy' }] },
          // An unreachable peer's cached rows are never positive evidence.
          {
            nodeId: 'hrcdev',
            state: 'unreachable',
            runtimes: [{ scopeRef: scope, status: 'ready' }],
          },
        ],
      }
    },
  } as unknown as Parameters<typeof federatedLiveRuntimes>[0]

  expect(await federatedLiveRuntimes(client, scope)).toEqual({
    localNodeId: 'svc',
    liveNodeIds: ['max3'],
    unansweredNodeIds: ['hrcdev'],
  })
  expect(filter).toEqual({ scope })
})
