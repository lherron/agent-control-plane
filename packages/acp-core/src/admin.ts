import type { Actor } from './models/actor.js'

export type AdminAgentStatus = 'active' | 'disabled'

export type MembershipRole = 'coordinator' | 'implementer' | 'tester' | 'observer'

export type AdminAgent = {
  agentId: string
  displayName?: string | undefined
  homeDir?: string | undefined
  status: AdminAgentStatus
  createdAt: string
  updatedAt: string
  createdBy: Actor
  updatedBy: Actor
}

export type AdminProject = {
  projectId: string
  displayName: string
  defaultAgentId?: string | undefined
  rootDir?: string | undefined
  createdAt: string
  updatedAt: string
  createdBy: Actor
  updatedBy: Actor
}

export type AdminMembership = {
  projectId: string
  agentId: string
  role: MembershipRole
  createdAt: string
  createdBy: Actor
}

export type InterfaceIdentity = {
  gatewayId: string
  externalId: string
  displayName?: string | undefined
  linkedAgentId?: string | undefined
  createdAt: string
  updatedAt: string
}

export type SystemEvent = {
  eventId: string
  projectId: string
  kind: string
  payload: Record<string, unknown>
  occurredAt: string
  recordedAt: string
}

export type AgentHeartbeatStatus = 'alive' | 'stale'

export type AgentHeartbeat = {
  agentId: string
  lastHeartbeatAt: string
  source?: string | undefined
  lastNote?: string | undefined
  status: AgentHeartbeatStatus
  targetScopeRef?: string | undefined
  targetLaneRef?: string | undefined
}
