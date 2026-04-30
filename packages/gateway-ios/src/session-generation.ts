import type { HrcSessionRecord } from 'hrc-core'
import { normalizeSessionRef, splitSessionRef } from 'hrc-core'

export type SessionGenerationClient = {
  listSessions(filter?: {
    scopeRef?: string | undefined
    laneRef?: string | undefined
  }): Promise<HrcSessionRecord[]>
}

export type SessionGenerationSelector = {
  sessionRef: string
  scopeRef: string
  laneRef: string
  hostSessionId: string
  generation: number
}

export type SessionGenerationInput = {
  sessionRef: string
  hostSessionId?: string | undefined
  generation?: number | undefined
}

function compareLatest(a: HrcSessionRecord, b: HrcSessionRecord): number {
  if (a.generation !== b.generation) return b.generation - a.generation
  return b.updatedAt.localeCompare(a.updatedAt)
}

function pickActiveLatest(candidates: HrcSessionRecord[]): HrcSessionRecord | undefined {
  const active = candidates.filter((session) => session.status === 'active')
  const pool = active.length > 0 ? active : candidates
  return [...pool].sort(compareLatest)[0]
}

export async function resolveSessionGeneration(
  client: SessionGenerationClient,
  input: SessionGenerationInput
): Promise<SessionGenerationSelector> {
  const sessionRef = normalizeSessionRef(input.sessionRef)
  const { scopeRef, laneRef } = splitSessionRef(sessionRef)

  if (input.hostSessionId !== undefined && input.hostSessionId.trim().length > 0) {
    if (input.generation !== undefined) {
      return {
        sessionRef,
        scopeRef,
        laneRef,
        hostSessionId: input.hostSessionId,
        generation: input.generation,
      }
    }

    const sessions = await client.listSessions({ scopeRef, laneRef })
    const match = sessions.find(
      (session) =>
        session.scopeRef === scopeRef &&
        session.laneRef === laneRef &&
        session.hostSessionId === input.hostSessionId
    )
    return {
      sessionRef,
      scopeRef,
      laneRef,
      hostSessionId: input.hostSessionId,
      generation: match?.generation ?? 0,
    }
  }

  const sessions = await client.listSessions({ scopeRef, laneRef })
  const latest = pickActiveLatest(
    sessions.filter((session) => session.scopeRef === scopeRef && session.laneRef === laneRef)
  )
  if (!latest) {
    throw new Error(`session not found: ${sessionRef}`)
  }

  return {
    sessionRef,
    scopeRef,
    laneRef,
    hostSessionId: latest.hostSessionId,
    generation: latest.generation,
  }
}
