/**
 * The reconciler's view of one scan. Everything here is read from current wrkq
 * and HRC state; nothing persists between scans.
 */

export const START_FACT_TYPE = 'delegation.started'
export const STALL_FACT_TYPE = 'delegation.stalled'

export type StallKind = 'ended_holder' | 'unclaimed_reservation' | 'orphaned_in_progress'

/** `meta.acp.request` — exactly `{ rev: <positive integer> }`. */
export type RequestMarker =
  | Readonly<{ ok: true; rev: number }>
  | Readonly<{ ok: false; reason: string }>

export type RequestClaim = Readonly<{
  by: string
  /** Task-scoped sessionRef, e.g. `agent:x:project:p:task:T-1/lane:main`. */
  scope: string
  node: string
  generation: number
}>

export type RequestRecord = Readonly<{
  id: string
  /** wrkq project path, used as the HRC project id. */
  projectId: string
  /** wrkq project container id (`P-NNNNN`); unscoped, unlike the path. */
  projectContainerId?: string | undefined
  state: string
  priority: number
  createdAt: string
  updatedAt: string
  assigneePrincipalRef?: string | undefined
  requesterPrincipalRef?: string | undefined
  requesterScopeRef?: string | undefined
  marker: RequestMarker
  claim?: RequestClaim | undefined
  /** Last claim generation, kept after release. */
  claimGeneration?: number | undefined
  ownerId?: string | undefined
  /** The subtask owner is archived or deleted. */
  ownerGone?: boolean | undefined
}>

export type StartFact = Readonly<{
  startKey: string
  rev: string
  assigneeSeat: string
  occurredAt: string
}>

export type StallFact = Readonly<{ kind: string; episode: string; occurredAt: string }>

export type RequestFacts = Readonly<{ starts: readonly StartFact[]; stalls: readonly StallFact[] }>

/** Observed liveness of a claim holder's seat. `unknown` is never a stall. */
export type HolderLiveness = 'live' | 'ended' | 'unknown'

/** The worker a request would start: its seat handle and the parts HRC resolves. */
export type WorkerRef = Readonly<{
  seat: string
  agentId: string
  projectId: string
  taskId: string
}>

/** Whether HRC holds a session for a reserved seat. `unknown` on a failed read. */
export type SeatObservation = 'session' | 'none' | 'unknown'

export type WorkerValidity = Readonly<{ ok: true }> | Readonly<{ ok: false; reason: string }>

const UNFINISHED_STATES = new Set(['idea', 'draft', 'open', 'in_progress', 'blocked'])

export function isUnfinished(state: string): boolean {
  return UNFINISHED_STATES.has(state)
}

export function parseRequestMarker(
  meta: Readonly<Record<string, unknown>>
): RequestMarker | undefined {
  const acp = meta['acp']
  if (acp === undefined || acp === null || typeof acp !== 'object' || Array.isArray(acp)) {
    return undefined
  }
  if (!Object.hasOwn(acp, 'request')) return undefined
  const request = (acp as Record<string, unknown>)['request']
  if (request === null || typeof request !== 'object' || Array.isArray(request)) {
    return { ok: false, reason: 'meta.acp.request must be an object' }
  }
  const keys = Object.keys(request)
  const unknown = keys.filter((key) => key !== 'rev')
  if (unknown.length > 0) {
    return { ok: false, reason: `meta.acp.request has unknown field(s): ${unknown.join(', ')}` }
  }
  const rev = (request as Record<string, unknown>)['rev']
  if (typeof rev !== 'number' || !Number.isSafeInteger(rev) || rev < 1) {
    return { ok: false, reason: 'meta.acp.request.rev must be a positive integer' }
  }
  return { ok: true, rev }
}

/** `agent:<id>` → `<id>`; anything else (a human, a malformed ref) → undefined. */
export function assigneeAgentId(assignee: string | undefined): string | undefined {
  const match = assignee?.match(/^agent:([a-z0-9][a-z0-9_-]*)$/)
  return match?.[1]
}

export function workerSeat(agentId: string, projectId: string, requestId: string): string {
  return `${agentId}@${projectId}:${requestId}`
}

export function seatScopeRef(agentId: string, projectId: string, taskId: string): string {
  return `agent:${agentId}:project:${projectId}:task:${taskId}`
}

export function startKey(requestId: string, rev: number, seat: string): string {
  return `recon:${requestId}:${rev}:${seat}`
}

export function stallKey(requestId: string, kind: StallKind, episode: string): string {
  return `stall:${requestId}:${kind}:${episode}`
}

/** `…/lane:main` sessionRef → canonical scopeRef. */
export function scopeRefOfSession(sessionRef: string): string {
  const lane = sessionRef.indexOf('/lane:')
  return lane === -1 ? sessionRef : sessionRef.slice(0, lane)
}

/** The agent id in an `agent:<id>` or `agent:<id>:project:…` ref. */
export function agentIdOfRef(ref: string): string | undefined {
  return ref.match(/^agent:([^:/]+)/)?.[1]
}
