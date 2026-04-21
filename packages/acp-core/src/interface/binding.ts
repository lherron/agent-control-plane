export interface InterfaceSessionRef {
  scopeRef: string
  laneRef: string
}

export type InterfaceBindingStatus = 'active' | 'disabled'

export interface InterfaceBinding {
  bindingId: string
  gatewayId: string
  conversationRef: string
  threadRef?: string | undefined
  sessionRef: InterfaceSessionRef
  projectId?: string | undefined
  status: InterfaceBindingStatus
  createdAt: string
  updatedAt: string
}

export interface InterfaceBindingLookup {
  gatewayId: string
  conversationRef: string
  threadRef?: string | undefined
}

function isActiveBinding(binding: InterfaceBinding): boolean {
  return binding.status === 'active'
}

function matchesGatewayConversation(
  binding: InterfaceBinding,
  lookup: InterfaceBindingLookup
): boolean {
  return (
    binding.gatewayId === lookup.gatewayId && binding.conversationRef === lookup.conversationRef
  )
}

export function resolveBinding(
  bindings: readonly InterfaceBinding[],
  lookup: InterfaceBindingLookup
): InterfaceBinding | null {
  if (lookup.threadRef !== undefined) {
    const exactBinding = bindings.find(
      (binding) =>
        isActiveBinding(binding) &&
        matchesGatewayConversation(binding, lookup) &&
        binding.threadRef === lookup.threadRef
    )

    if (exactBinding !== undefined) {
      return exactBinding
    }
  }

  const channelBinding = bindings.find(
    (binding) =>
      isActiveBinding(binding) &&
      matchesGatewayConversation(binding, lookup) &&
      binding.threadRef === undefined
  )

  return channelBinding ?? null
}
