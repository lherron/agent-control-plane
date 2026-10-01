import { assignmentBody, stallNoticeBody } from './assignment.js'
import type { ReconcilerConfig } from './config.js'
import { type Decision, evaluate, needsLiveness, needsWorkerValidity } from './evaluate.js'
import {
  type HolderLiveness,
  type RequestFacts,
  type RequestRecord,
  STALL_FACT_TYPE,
  START_FACT_TYPE,
  type WorkerValidity,
  assigneeAgentId,
  isUnfinished,
  workerSeat,
} from './model.js'
import type { ReconcilerReader, ReconcilerWriter } from './ports.js'

export type ReconcilerLog = (line: string) => void

export type Snapshot = Readonly<{
  localNodeId: string
  requests: readonly RequestRecord[]
  facts: ReadonlyMap<string, RequestFacts>
  liveness: ReadonlyMap<string, HolderLiveness>
  validity: ReadonlyMap<string, WorkerValidity>
}>

export type ExplainResult = Readonly<{
  at: string
  localNodeId: string
  capacity: Readonly<{ global: number; perAgent: number; claimWindowMs: number }>
  decisions: readonly Decision[]
}>

export type ScanAction =
  | Readonly<{ kind: 'reserved'; id: string; startKey: string }>
  | Readonly<{ kind: 'reservation_existing'; id: string; startKey: string }>
  | Readonly<{ kind: 'dispatched'; id: string; seat: string }>
  | Readonly<{ kind: 'dispatch_failed'; id: string; error: string }>
  | Readonly<{
      kind: 'stall_reported'
      id: string
      key: string
      notified: 'sent' | 'duplicate' | 'no_requester'
    }>
  | Readonly<{ kind: 'stall_existing'; id: string; key: string }>
  | Readonly<{ kind: 'failed'; id: string; error: string }>

export type ScanResult = Readonly<{
  decisions: readonly Decision[]
  actions: readonly ScanAction[]
}>

export type ReconcilerCoreOptions = Readonly<{
  config: Pick<
    ReconcilerConfig,
    'node' | 'intervalMs' | 'globalCapacity' | 'agentCapacity' | 'claimWindowMs'
  >
  reader: ReconcilerReader
  writer: ReconcilerWriter
  log?: ReconcilerLog | undefined
  now?: (() => Date) | undefined
}>

export type AcpReconciler = Readonly<{
  /** Checks the designated node, scans once, then every interval. */
  start(): Promise<void>
  stop(): Promise<void>
  scanOnce(): Promise<ScanResult>
  /** One loop iteration: a non-reentrant scan whose failure is logged, not thrown. */
  tick(): Promise<void>
  explain(taskId?: string): Promise<ExplainResult>
}>

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export async function readSnapshot(reader: ReconcilerReader): Promise<Snapshot> {
  const localNodeId = await reader.localNodeId()
  const requests = await reader.listRequests()
  const facts = new Map<string, RequestFacts>()
  const liveness = new Map<string, HolderLiveness>()
  const validity = new Map<string, WorkerValidity>()
  for (const request of requests) {
    if (!isUnfinished(request.state) || request.ownerGone || !request.marker.ok) continue
    const requestFacts = await reader.readFacts(request)
    facts.set(request.id, requestFacts)
    if (needsLiveness(request) && request.claim !== undefined) {
      liveness.set(request.id, await reader.holderLiveness(request.claim, localNodeId))
    }
    if (needsWorkerValidity(request, requestFacts)) {
      const seat = seatFor(request)
      if (seat !== undefined) validity.set(request.id, await reader.workerValidity(seat))
    }
  }
  return { localNodeId, requests, facts, liveness, validity }
}

function seatFor(request: RequestRecord): string | undefined {
  const agentId = assigneeAgentId(request.assigneePrincipalRef)
  return agentId === undefined ? undefined : workerSeat(agentId, request.projectId, request.id)
}

/** Log keys for decisions worth a line: changes, never steady waiting state. */
function transitionKey(decision: Decision): string | undefined {
  switch (decision.kind) {
    case 'start':
      return `start:${decision.startKey}`
    case 'stall':
      return `stall:${decision.stall.key}`
    case 'invalid':
      return `invalid:${decision.reason}`
    default:
      return undefined
  }
}

export function createReconcilerCore(options: ReconcilerCoreOptions): AcpReconciler {
  const { config, reader, writer } = options
  const log = options.log ?? ((line: string) => console.log(line))
  const now = options.now ?? (() => new Date())
  const lastLogged = new Map<string, string>()
  let timer: ReturnType<typeof setInterval> | undefined
  let inFlight: Promise<unknown> | undefined
  let lastScanFailure: string | undefined

  const evaluateSnapshot = (snapshot: Snapshot) =>
    evaluate({
      now: now(),
      globalCapacity: config.globalCapacity,
      agentCapacity: config.agentCapacity,
      claimWindowMs: config.claimWindowMs,
      requests: snapshot.requests,
      facts: snapshot.facts,
      liveness: snapshot.liveness,
      validity: snapshot.validity,
    })

  function logTransitions(decisions: readonly Decision[]) {
    const seen = new Set<string>()
    for (const decision of decisions) {
      seen.add(decision.id)
      const key = transitionKey(decision)
      if (key === undefined) {
        lastLogged.delete(decision.id)
        continue
      }
      if (lastLogged.get(decision.id) === key) continue
      lastLogged.set(decision.id, key)
      log(`acp-reconciler: ${decision.id} ${decision.kind}: ${decision.reason}`)
    }
    for (const id of lastLogged.keys()) if (!seen.has(id)) lastLogged.delete(id)
  }

  async function reserveAndStart(
    request: RequestRecord,
    decision: Extract<Decision, { kind: 'start' }>,
    actions: ScanAction[]
  ) {
    const attributes: Record<string, string> = {
      assignee_seat: decision.seat,
      rev: String(decision.rev),
      start_key: decision.startKey,
    }
    if (request.requesterPrincipalRef !== undefined)
      attributes['requester'] = request.requesterPrincipalRef
    let outcome: 'created' | 'existing'
    try {
      outcome = await writer.postFact({
        task: request.id,
        type: START_FACT_TYPE,
        key: decision.startKey,
        summary: `reserved start of ${decision.seat} for ${request.id}@${decision.rev}`,
        attributes,
      })
    } catch (error) {
      // Two copies inserting one key race on wrkq's unique index and the loser
      // sees an error, not a replay. Re-read: a fact under our key means the
      // other copy owns the start.
      const facts = await reader.readFacts(request)
      if (!facts.starts.some((fact) => fact.startKey === decision.startKey)) throw error
      outcome = 'existing'
    }
    if (outcome === 'existing') {
      actions.push({ kind: 'reservation_existing', id: request.id, startKey: decision.startKey })
      return
    }
    actions.push({ kind: 'reserved', id: request.id, startKey: decision.startKey })
    log(`acp-reconciler: ${request.id} reserved ${decision.startKey}`)
    try {
      await writer.startWorker({
        seat: decision.seat,
        body: assignmentBody(request, decision),
        startKey: decision.startKey,
      })
      actions.push({ kind: 'dispatched', id: request.id, seat: decision.seat })
      log(`acp-reconciler: ${request.id} dispatched to ${decision.seat}`)
    } catch (error) {
      // The reservation stands; the unclaimed-reservation rule reports it.
      actions.push({ kind: 'dispatch_failed', id: request.id, error: message(error) })
      log(`acp-reconciler: ${request.id} dispatch to ${decision.seat} failed: ${message(error)}`)
    }
  }

  async function reportStall(
    request: RequestRecord,
    decision: Extract<Decision, { kind: 'stall' }>,
    actions: ScanAction[]
  ) {
    const attributes: Record<string, string> = {
      kind: decision.stall.kind,
      episode: decision.stall.episode,
      ...decision.evidence,
    }
    if (request.requesterPrincipalRef !== undefined)
      attributes['requester'] = request.requesterPrincipalRef
    const outcome = await writer.postFact({
      task: request.id,
      type: STALL_FACT_TYPE,
      key: decision.stall.key,
      summary: `${decision.stall.kind}: ${decision.reason}`,
      attributes,
    })
    if (outcome === 'existing') {
      actions.push({ kind: 'stall_existing', id: request.id, key: decision.stall.key })
      return
    }
    const to = request.requesterScopeRef ?? request.requesterPrincipalRef
    const notified =
      to === undefined
        ? 'no_requester'
        : await writer.notify({
            task: request.id,
            to,
            body: stallNoticeBody(request, decision),
            key: decision.stall.key,
          })
    actions.push({ kind: 'stall_reported', id: request.id, key: decision.stall.key, notified })
    log(`acp-reconciler: ${request.id} stalled ${decision.stall.key} (notice: ${notified})`)
  }

  async function scanOnce(): Promise<ScanResult> {
    const snapshot = await readSnapshot(reader)
    const decisions = evaluateSnapshot(snapshot)
    logTransitions(decisions)
    const byId = new Map(snapshot.requests.map((request) => [request.id, request]))
    const actions: ScanAction[] = []
    for (const decision of decisions) {
      const request = byId.get(decision.id)
      if (request === undefined) continue
      try {
        if (decision.kind === 'start') await reserveAndStart(request, decision, actions)
        else if (decision.kind === 'stall' && !decision.reported) {
          await reportStall(request, decision, actions)
        }
      } catch (error) {
        actions.push({ kind: 'failed', id: decision.id, error: message(error) })
        log(`acp-reconciler: ${decision.id} ${decision.kind} failed: ${message(error)}`)
      }
    }
    return { decisions, actions }
  }

  async function tick() {
    if (inFlight !== undefined) return
    // A failed scan is retried on the next tick; repeat the line only when the
    // failure changes, so a long wrkq outage does not flood the host log.
    const run = scanOnce().then(
      () => {
        if (lastScanFailure !== undefined) log('acp-reconciler: scans recovered')
        lastScanFailure = undefined
      },
      (error) => {
        const failure = message(error)
        if (failure !== lastScanFailure) log(`acp-reconciler: scan failed: ${failure}`)
        lastScanFailure = failure
      }
    )
    inFlight = run
    try {
      await run
    } finally {
      inFlight = undefined
    }
  }

  return {
    async start() {
      if (timer !== undefined) return
      const localNodeId = await reader.localNodeId()
      if (localNodeId !== config.node) {
        log(`acp-reconciler: idle; designated node ${config.node}, this node is ${localNodeId}`)
        return
      }
      log(
        `acp-reconciler: running on ${localNodeId} every ${config.intervalMs}ms (capacity ${config.globalCapacity}/${config.agentCapacity}, claim window ${config.claimWindowMs}ms)`
      )
      timer = setInterval(() => void tick(), config.intervalMs)
      await tick()
    },
    async stop() {
      if (timer !== undefined) clearInterval(timer)
      timer = undefined
      await inFlight
    },
    scanOnce,
    tick,
    explain: (taskId) => explainWith(reader, config, now, taskId),
  }
}

/** Read-only: takes a reader and nothing that can write. */
export async function explainWith(
  reader: ReconcilerReader,
  config: Pick<ReconcilerConfig, 'globalCapacity' | 'agentCapacity' | 'claimWindowMs'>,
  now: () => Date,
  taskId?: string
): Promise<ExplainResult> {
  const snapshot = await readSnapshot(reader)
  const at = now()
  const decisions = evaluate({
    now: at,
    globalCapacity: config.globalCapacity,
    agentCapacity: config.agentCapacity,
    claimWindowMs: config.claimWindowMs,
    requests: snapshot.requests,
    facts: snapshot.facts,
    liveness: snapshot.liveness,
    validity: snapshot.validity,
  })
  return {
    at: at.toISOString(),
    localNodeId: snapshot.localNodeId,
    capacity: {
      global: config.globalCapacity,
      perAgent: config.agentCapacity,
      claimWindowMs: config.claimWindowMs,
    },
    decisions:
      taskId === undefined ? decisions : decisions.filter((decision) => decision.id === taskId),
  }
}
