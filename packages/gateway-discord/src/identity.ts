import { parseScopeRef } from 'agent-scope'

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
  avatarUrl?: string | undefined
  webhookAvatar?: DiscordWebhookAvatar | undefined
}

export type DiscordWebhookAvatar = {
  key: string
  data: Buffer
}

export function identityFromSessionRef(sessionRef: DiscordSessionRef): DiscordAgentIdentity {
  const parsed = parseScopeRef(sessionRef.scopeRef)
  return {
    agentId: parsed.agentId,
    scopeRef: sessionRef.scopeRef,
    ...(sessionRef.laneRef !== undefined ? { laneRef: sessionRef.laneRef } : {}),
  }
}

export function formatSessionSubtext(sessionRef: DiscordSessionRef): string {
  const parsed = parseScopeRef(sessionRef.scopeRef)
  let text = parsed.agentId

  if (parsed.projectId !== undefined) {
    text += `@${parsed.projectId}`
  }

  if (parsed.taskId !== undefined) {
    text += `:${parsed.taskId}`
  }

  if (parsed.roleName !== undefined) {
    text += `:${parsed.roleName}`
  }

  if (sessionRef.laneRef !== undefined) {
    text += `~${sessionRef.laneRef}`
  }

  return text
}

export const avatarFor = (agentId: string): string =>
  `https://api.dicebear.com/7.x/bottts/png?seed=${encodeURIComponent(agentId)}`
