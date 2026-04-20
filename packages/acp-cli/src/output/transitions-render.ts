import type { LoggedTransitionRecord } from 'acp-core'

export function renderTransitionApplied(input: {
  taskId: string
  transition: LoggedTransitionRecord
  version: number
  handoff?: Record<string, unknown> | undefined
  wake?: Record<string, unknown> | undefined
}): string {
  const lines = [
    `Transitioned ${input.taskId} ${input.transition.from.phase} → ${input.transition.to.phase} (v ${input.version})`,
  ]

  if (input.handoff !== undefined) {
    const handoffId =
      typeof input.handoff['handoffId'] === 'string' ? input.handoff['handoffId'] : 'handoff'
    const state = typeof input.handoff['state'] === 'string' ? input.handoff['state'] : 'open'
    lines.push(`Handoff: ${handoffId} (${state})`)
  }

  if (input.wake !== undefined) {
    const wakeId = typeof input.wake['wakeId'] === 'string' ? input.wake['wakeId'] : 'wake'
    const state = typeof input.wake['state'] === 'string' ? input.wake['state'] : 'queued'
    lines.push(`Wake: ${wakeId} (${state})`)
  }

  return lines.join('\n')
}

export function renderTransitions(transitions: readonly LoggedTransitionRecord[]): string {
  if (transitions.length === 0) {
    return 'No transitions recorded.'
  }

  return [
    'Transitions:',
    ...transitions.map(
      (transition) =>
        `- ${transition.timestamp} ${transition.actor.role}:${transition.actor.agentId} ${transition.from.phase} -> ${transition.to.phase} (v ${transition.nextVersion})`
    ),
  ].join('\n')
}
