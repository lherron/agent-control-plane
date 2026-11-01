import { isTerminalRuntimeStatus } from 'hrc-core'
import type { HrcClient } from 'hrc-sdk'

import type { FederatedScopeRuntimes } from './policy/contracts.js'

/**
 * Which nodes report a live runtime for one exact scope (T-12214), from HRC's
 * existing federated runtime inventory.
 *
 * The inventory's `scope` filter is a prefix match and includes history, so the
 * exact scope and liveness are decided here. A peer that did not answer adds
 * nothing to `liveNodeIds`, not even its cached rows: a stale positive would
 * park mail behind a node that may no longer hold the seat. It is named in
 * `unansweredNodeIds` instead, so policy never reads its silence as "nothing
 * runs there".
 */
export async function federatedLiveRuntimes(
  client: Pick<HrcClient, 'listFederatedRuntimes'>,
  scopeRef: string
): Promise<FederatedScopeRuntimes> {
  const report = await client.listFederatedRuntimes({ scope: scopeRef })
  const liveNodeIds: string[] = []
  const unansweredNodeIds: string[] = []
  for (const node of report.nodes) {
    if (node.state !== 'answered') {
      unansweredNodeIds.push(node.nodeId)
      continue
    }
    const live = node.runtimes.some(
      (runtime) =>
        runtime.scopeRef === scopeRef &&
        !isTerminalRuntimeStatus(runtime.status) &&
        runtime.status !== 'detached'
    )
    if (live) liveNodeIds.push(node.nodeId)
  }
  return { localNodeId: report.localNodeId, liveNodeIds, unansweredNodeIds }
}
