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
      workerValidity: async (seat): Promise<WorkerValidity> =>
        this.invalidAgents.has(seat.split('@')[0] ?? '')
          ? { ok: false, reason: 'agent not found' }
          : { ok: true },
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
        if (this.failDispatch) throw new Error('hrc unavailable')
        this.dispatched.push(input)
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
