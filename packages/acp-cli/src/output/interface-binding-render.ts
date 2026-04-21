import type { InterfaceBinding } from 'acp-core'

function renderBinding(binding: InterfaceBinding): string {
  const lines = [
    `${binding.bindingId} ${binding.status}`,
    `  gateway: ${binding.gatewayId}`,
    `  conversation: ${binding.conversationRef}`,
    `  session: ${binding.sessionRef.scopeRef} (${binding.sessionRef.laneRef})`,
  ]

  if (binding.threadRef !== undefined) {
    lines.push(`  thread: ${binding.threadRef}`)
  }

  if (binding.projectId !== undefined) {
    lines.push(`  project: ${binding.projectId}`)
  }

  lines.push(`  updated: ${binding.updatedAt}`)
  return lines.join('\n')
}

export function renderInterfaceBindings(bindings: readonly InterfaceBinding[]): string {
  if (bindings.length === 0) {
    return 'No interface bindings found.'
  }

  return bindings.map((binding) => renderBinding(binding)).join('\n\n')
}
