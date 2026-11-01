import { expect, test } from 'bun:test'

import type {
  FederationNodeRuntimeProjection,
  FederationRuntimeProjectionReport,
  HrcRuntimeSnapshot,
} from 'hrc-core'
import type { HrcClient } from 'hrc-sdk'

import { federatedLiveRuntimes } from '../src/federated-runtimes.js'

const AT = '2026-11-01T05:34:45.000Z'

/** A full runtime row; only scopeRef and status vary across these cases. */
function runtime(
  scopeRef: string,
  status: HrcRuntimeSnapshot['status'],
  nodeId: string
): HrcRuntimeSnapshot {
  return {
    runtimeId: `rt-${nodeId}-${status}`,
    hostSessionId: `hsid-${nodeId}`,
    scopeRef,
    laneRef: 'main',
    generation: 1,
    transport: 'tmux',
    status,
    supportsInflightInput: false,
    createdAt: AT,
    updatedAt: AT,
  }
}

function node(
  nodeId: string,
  state: FederationNodeRuntimeProjection['state'],
  runtimes: Array<[scopeRef: string, status: HrcRuntimeSnapshot['status']]>
): FederationNodeRuntimeProjection {
  return {
    nodeId,
    state,
    checkedAt: AT,
    latencyMs: 1,
    runtimes: runtimes.map(([scopeRef, status]) => runtime(scopeRef, status, nodeId)),
  }
}

test('projects exact-scope live runtimes per node and names unanswered peers (T-12214)', async () => {
  const scope = 'agent:stella:project:hrc-ios:task:primary-pulsar-2'
  let filter: unknown
  const client: Pick<HrcClient, 'listFederatedRuntimes'> = {
    async listFederatedRuntimes(input): Promise<FederationRuntimeProjectionReport> {
      filter = input
      return {
        localNodeId: 'svc',
        generatedAt: AT,
        nodes: [
          // A prefix sibling and a history row are not this scope live here.
          node('svc', 'answered', [
            [`${scope}-old`, 'ready'],
            [scope, 'terminated'],
          ]),
          node('max3', 'answered', [[scope, 'busy']]),
          // An unreachable peer's cached rows are never positive evidence.
          node('hrcdev', 'unreachable', [[scope, 'ready']]),
        ],
      }
    },
  }

  expect(await federatedLiveRuntimes(client, scope)).toEqual({
    localNodeId: 'svc',
    liveNodeIds: ['max3'],
    unansweredNodeIds: ['hrcdev'],
  })
  expect(filter).toEqual({ scope })
})
