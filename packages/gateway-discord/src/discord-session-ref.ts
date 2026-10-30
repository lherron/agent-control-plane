import type { InterfaceSessionRef } from 'acp-core'
import { parseScopeRef, validateScopeRef } from 'agent-scope'
import type { DiscordInterfaceBinding } from './types.js'

export function projectIdFromScopeRef(scopeRef: string): string {
  // Use the canonical agent-scope parser. Falls back to the raw scopeRef
  // when the input isn't a well-formed scope or lacks a project segment —
  // intended only for logging/diagnostic contexts. Healthy code paths
  // should prefer `binding.projectId` directly (always populated since
  // the projectId-required validation landed).
  const validation = validateScopeRef(scopeRef)
  if (!validation.ok) {
    return scopeRef
  }
  return parseScopeRef(scopeRef).projectId ?? scopeRef
}

export function laneIdFromRef(laneRef: string): string {
  return laneRef.startsWith('lane:') ? laneRef.slice('lane:'.length) : laneRef
}

export function canonicalSessionRefString(sessionRef: InterfaceSessionRef): string {
  return `${sessionRef.scopeRef}/lane:${laneIdFromRef(sessionRef.laneRef)}`
}

export function sessionRefFromBinding(
  binding: DiscordInterfaceBinding
): InterfaceSessionRef | undefined {
  if (binding.sessionRef !== undefined) {
    return binding.sessionRef
  }

  const legacy = binding as DiscordInterfaceBinding & {
    scopeRef?: string | undefined
    laneRef?: string | undefined
  }
  if (legacy.scopeRef !== undefined && legacy.laneRef !== undefined) {
    return { scopeRef: legacy.scopeRef, laneRef: legacy.laneRef }
  }

  return undefined
}
