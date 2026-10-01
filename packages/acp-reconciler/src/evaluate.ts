import {
  type HolderLiveness,
  type RequestFacts,
  type RequestRecord,
  type StallKind,
  type WorkerValidity,
  agentIdOfRef,
  assigneeAgentId,
  isUnfinished,
  stallKey,
  startKey,
  workerSeat,
} from './model.js'

export type EvaluationInput = Readonly<{
  now: Date
  globalCapacity: number
  agentCapacity: number
  claimWindowMs: number
  requests: readonly RequestRecord[]
  facts: ReadonlyMap<string, RequestFacts>
  /** Observed for every claimed, unfinished request; missing means unknown. */
  liveness: ReadonlyMap<string, HolderLiveness>
  /** Resolved for every request {@link needsWorkerValidity} selects. */
  validity: ReadonlyMap<string, WorkerValidity>
}>

type DecisionBase = Readonly<{ id: string; reason: string; evidence?: Record<string, string> }>

export type Decision =
  | (DecisionBase & {
      kind: 'start'
      agentId: string
      seat: string
      rev: number
      startKey: string
    })
  | (DecisionBase & {
      kind: 'stall'
      stall: Readonly<{ kind: StallKind; episode: string; key: string }>
      /** A matching delegation.stalled fact already exists. */
      reported: boolean
    })
  | (DecisionBase & { kind: 'active' | 'wait' | 'invalid' | 'skip' })

/** The current reservation key for a request, when it is startable at all. */
export function currentStartKey(request: RequestRecord): string | undefined {
  if (!request.marker.ok) return undefined
  const agentId = assigneeAgentId(request.assigneePrincipalRef)
  if (agentId === undefined) return undefined
  return startKey(
    request.id,
    request.marker.rev,
    workerSeat(agentId, request.projectId, request.id)
  )
}

/** Open, unclaimed, agent-assigned and not already reserved: needs an HRC validity read. */
export function needsWorkerValidity(
  request: RequestRecord,
  facts: RequestFacts | undefined
): boolean {
  if (request.state !== 'open' || request.claim !== undefined || request.ownerGone) return false
  const key = currentStartKey(request)
  return key !== undefined && !facts?.starts.some((fact) => fact.startKey === key)
}

export function needsLiveness(request: RequestRecord): boolean {
  return request.claim !== undefined && isUnfinished(request.state) && request.marker.ok
}

function byPriorityThenAge(a: RequestRecord, b: RequestRecord): number {
  return (
    a.priority - b.priority || a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id)
  )
}

function elapsedMs(now: Date, since: string): number {
  const at = Date.parse(since)
  return Number.isNaN(at) ? 0 : now.getTime() - at
}

/**
 * Pure, deterministic: the same snapshot always yields the same decisions in
 * the same order. Capacity is charged first for active claims and current
 * reservations, then admitted in priority/age/id order.
 */
export function evaluate(input: EvaluationInput): Decision[] {
  const decisions = new Map<string, Decision>()
  const candidates: Array<Extract<Decision, { kind: 'start' }>> = []
  const perAgent = new Map<string, number>()
  let used = 0
  const charge = (agentId: string | undefined) => {
    used += 1
    if (agentId !== undefined) perAgent.set(agentId, (perAgent.get(agentId) ?? 0) + 1)
  }

  for (const request of [...input.requests].sort(byPriorityThenAge)) {
    const id = request.id
    const facts = input.facts.get(id) ?? { starts: [], stalls: [] }
    const stall = (
      kind: StallKind,
      episode: string,
      reason: string,
      evidence: Record<string, string>
    ) => {
      const reported = facts.stalls.some((fact) => fact.kind === kind && fact.episode === episode)
      decisions.set(id, {
        id,
        kind: 'stall',
        stall: { kind, episode, key: stallKey(id, kind, episode) },
        reported,
        reason,
        evidence,
      })
    }

    if (!isUnfinished(request.state)) {
      decisions.set(id, { id, kind: 'skip', reason: `request is ${request.state}` })
      continue
    }
    if (request.ownerGone) {
      decisions.set(id, {
        id,
        kind: 'skip',
        reason: `owner ${request.ownerId} is archived or deleted`,
      })
      continue
    }
    if (!request.marker.ok) {
      decisions.set(id, { id, kind: 'invalid', reason: request.marker.reason })
      continue
    }

    if (request.claim !== undefined) {
      const claim = request.claim
      charge(agentIdOfRef(claim.by))
      const liveness = input.liveness.get(id) ?? 'unknown'
      const evidence = {
        holder: claim.by,
        scope: claim.scope,
        node: claim.node,
        generation: String(claim.generation),
        liveness,
      }
      if (liveness === 'ended') {
        stall('ended_holder', String(claim.generation), 'claim held by an ended worker', evidence)
      } else {
        decisions.set(id, {
          id,
          kind: 'active',
          reason: `claimed by ${claim.by} (worker ${liveness})`,
          evidence,
        })
      }
      continue
    }

    const key = currentStartKey(request)
    const reservation =
      key === undefined ? undefined : facts.starts.find((fact) => fact.startKey === key)
    if (reservation !== undefined) {
      charge(assigneeAgentId(request.assigneePrincipalRef))
      const evidence = { start_key: reservation.startKey, reserved_at: reservation.occurredAt }
      if (elapsedMs(input.now, reservation.occurredAt) > input.claimWindowMs) {
        stall(
          'unclaimed_reservation',
          reservation.startKey,
          'reserved start not claimed within the claim window',
          evidence
        )
      } else {
        decisions.set(id, {
          id,
          kind: 'active',
          reason: 'reserved; awaiting the worker claim',
          evidence,
        })
      }
      continue
    }

    if (request.state === 'in_progress') {
      const episode = String(request.claimGeneration ?? 0)
      const evidence = { updated_at: request.updatedAt, claim_generation: episode }
      if (elapsedMs(input.now, request.updatedAt) > input.claimWindowMs) {
        stall(
          'orphaned_in_progress',
          episode,
          'in_progress, unclaimed and unreserved past the claim window',
          evidence
        )
      } else {
        decisions.set(id, {
          id,
          kind: 'wait',
          reason: 'in_progress and unclaimed; inside the claim window',
          evidence,
        })
      }
      continue
    }
    if (request.state !== 'open') {
      decisions.set(id, {
        id,
        kind: 'wait',
        reason: `request is ${request.state}; only open requests start`,
      })
      continue
    }
    if (request.assigneePrincipalRef === undefined) {
      decisions.set(id, { id, kind: 'wait', reason: 'no assignee' })
      continue
    }
    const agentId = assigneeAgentId(request.assigneePrincipalRef)
    if (agentId === undefined || key === undefined) {
      decisions.set(id, {
        id,
        kind: 'wait',
        reason: `assignee ${request.assigneePrincipalRef} is not an agent; never started`,
      })
      continue
    }
    const validity = input.validity.get(id)
    if (validity === undefined || !validity.ok) {
      decisions.set(id, {
        id,
        kind: 'invalid',
        reason: `assignee ${request.assigneePrincipalRef} is not a startable agent: ${
          validity?.ok === false ? validity.reason : 'not resolved'
        }`,
      })
      continue
    }
    const seat = workerSeat(agentId, request.projectId, id)
    const candidate = {
      id,
      kind: 'start' as const,
      agentId,
      seat,
      rev: request.marker.rev,
      startKey: key,
      reason: `startable for ${seat}`,
    }
    decisions.set(id, candidate)
    candidates.push(candidate)
  }

  for (const candidate of candidates) {
    const agentUsed = perAgent.get(candidate.agentId) ?? 0
    if (used >= input.globalCapacity) {
      decisions.set(candidate.id, {
        id: candidate.id,
        kind: 'wait',
        reason: `global capacity ${used}/${input.globalCapacity}`,
      })
    } else if (agentUsed >= input.agentCapacity) {
      decisions.set(candidate.id, {
        id: candidate.id,
        kind: 'wait',
        reason: `agent ${candidate.agentId} capacity ${agentUsed}/${input.agentCapacity}`,
      })
    } else {
      charge(candidate.agentId)
    }
  }
  return [...decisions.values()]
}
