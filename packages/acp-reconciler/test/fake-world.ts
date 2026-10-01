import {
  type HolderLiveness,
  type RequestRecord,
  STALL_FACT_TYPE,
  START_FACT_TYPE,
  type WorkerValidity,
} from '../src/model.js'
import type { FactPost, ReconcilerReader, ReconcilerWriter } from '../src/ports.js'

export type PostedFact = FactPost & { occurredAt: string }

/** In-memory wrkq + HRC: one shared world can back several reconciler copies. */
export class FakeWorld {
  now = new Date('2026-10-01T12:00:00Z')
  node = 'max3'
  requests = new Map<string, RequestRecord>()
  facts: PostedFact[] = []
  dispatched: Array<{ seat: string; body: string; startKey: string }> = []
  notices: Array<{ task: string; to: string; body: string; key: string }> = []
  liveness = new Map<string, HolderLiveness>()
  invalidAgents = new Set<string>()
  participantOnly = new Set<string>()
  /** HRC seat scopeRefs that have a session (a successful dispatch adds one). */
  sessions = new Set<string>()
  dispatchError = 'hrc unavailable'
  failDispatch = false
  /** Simulates the other copy winning the unique-index race. */
  raceOnKey: string | undefined
  writes = 0

  put(request: Partial<RequestRecord> & { id: string }): RequestRecord {
    const record: RequestRecord = {
      projectId: 'proj',
      state: 'open',
      priority: 2,
      createdAt: '2026-10-01T11:00:00Z',
      updatedAt: '2026-10-01T11:00:00Z',
      assigneePrincipalRef: 'agent:arris',
      requesterPrincipalRef: 'agent:mable',
      requesterScopeRef: 'mable@proj:T-1',
      marker: { ok: true, rev: 1 },
      ...request,
    }
    this.requests.set(record.id, record)
    return record
  }

  advance(ms: number) {
    this.now = new Date(this.now.getTime() + ms)
  }

  reader(): ReconcilerReader {
    return {
      localNodeId: async () => this.node,
      listRequests: async () => [...this.requests.values()],
      readFacts: async (request) => ({
        starts: this.facts
          .filter((fact) => fact.task === request.id && fact.type === START_FACT_TYPE)
          .map((fact) => ({
            startKey: fact.attributes['start_key'] ?? '',
            rev: fact.attributes['rev'] ?? '',
            assigneeSeat: fact.attributes['assignee_seat'] ?? '',
            occurredAt: fact.occurredAt,
          })),
        stalls: this.facts
          .filter((fact) => fact.task === request.id && fact.type === STALL_FACT_TYPE)
          .map((fact) => ({
            kind: fact.attributes['kind'] ?? '',
            episode: fact.attributes['episode'] ?? '',
            occurredAt: fact.occurredAt,
          })),
      }),
      holderLiveness: async (claim, localNodeId) =>
        claim.node !== localNodeId ? 'unknown' : (this.liveness.get(claim.scope) ?? 'unknown'),
      workerValidity: async (worker): Promise<WorkerValidity> => {
        if (this.invalidAgents.has(worker.agentId)) return { ok: false, reason: 'agent not found' }
        if (this.participantOnly.has(worker.agentId)) {
          return { ok: false, reason: `participant-only (${worker.agentId})` }
        }
        return { ok: true }
      },
      seatSession: async (scopeRef) => (this.sessions.has(scopeRef) ? 'session' : 'none'),
    }
  }

  writer(): ReconcilerWriter {
    return {
      postFact: async (fact) => {
        this.writes += 1
        if (this.raceOnKey === fact.key) {
          this.raceOnKey = undefined
          this.facts.push({ ...fact, occurredAt: this.now.toISOString() })
          throw new Error('INTERNAL: UNIQUE constraint failed: project_events.idempotency_key')
        }
        if (this.facts.some((existing) => existing.key === fact.key)) return 'existing'
        this.facts.push({ ...fact, occurredAt: this.now.toISOString() })
        return 'created'
      },
      startWorker: async (input) => {
        this.writes += 1
        if (this.failDispatch) throw new Error(this.dispatchError)
        this.dispatched.push(input)
        const [agentId, rest] = input.seat.split('@') as [string, string]
        const [projectId, taskId] = rest.split(':') as [string, string]
        this.sessions.add(`agent:${agentId}:project:${projectId}:task:${taskId}`)
      },
      notify: async (input) => {
        this.writes += 1
        if (this.notices.some((notice) => notice.key === input.key && notice.to === input.to)) {
          return 'duplicate'
        }
        this.notices.push(input)
        return 'sent'
      },
    }
  }
}

export const testConfig = {
  node: 'max3',
  intervalMs: 45_000,
  globalCapacity: 4,
  agentCapacity: 2,
  claimWindowMs: 600_000,
}
