import type { ResolvedAcpServerDeps } from '../deps.js'

export type ResolvedInterfaceSource = {
  gatewayId: string
  bindingId: string
  conversationRef: string
  threadRef?: string
  messageRef: string
}

export function resolveInterfaceSourceForScope(
  deps: ResolvedAcpServerDeps,
  input: {
    scopeRef: string
    laneRef: string
    messageRef: string
  }
): ResolvedInterfaceSource | undefined {
  const bindings = deps.interfaceStore.bindings.list()
  const binding = bindings.find(
    (b) => b.status === 'active' && b.scopeRef === input.scopeRef && b.laneRef === input.laneRef
  )
  if (binding === undefined) {
    return undefined
  }

  return {
    gatewayId: binding.gatewayId,
    bindingId: binding.bindingId,
    conversationRef: binding.conversationRef,
    ...(binding.threadRef !== undefined ? { threadRef: binding.threadRef } : {}),
    messageRef: input.messageRef,
  }
}
