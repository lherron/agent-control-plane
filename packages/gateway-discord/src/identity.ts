export type DiscordSessionRef = {
  scopeRef: string
  laneRef?: string | undefined
}

export type DiscordAgentIdentity = {
  agentId: string
  scopeRef: string
  laneRef?: string | undefined
}

export type DiscordAgentMessageIdentity = {
  agentId: string
  subtext: string
  avatarUrl: string
}

export function identityFromSessionRef(_sessionRef: DiscordSessionRef): DiscordAgentIdentity {
  throw new Error('identityFromSessionRef is not implemented')
}

export function formatSessionSubtext(_sessionRef: DiscordSessionRef): string {
  throw new Error('formatSessionSubtext is not implemented')
}

export function avatarFor(_agentId: string): string {
  throw new Error('avatarFor is not implemented')
}
