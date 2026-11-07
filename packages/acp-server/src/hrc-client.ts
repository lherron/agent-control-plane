/**
 * ACP's HRC client: the pinned hrc-sdk `HrcClient` plus the HRC routes ACP reads that it has no method for yet.
 */
import { HrcClient } from 'hrc-sdk'

/** One seat handoff as `GET /v1/seat-handoffs` lists it (max3 HRC 57000d0a, 2026-11-07). */
export type HrcSeatHandoff = {
  id: string
  scopeRef: string
  laneRef: string
  state: string
  createdAt: string
  acknowledgedAt?: string | null | undefined
}

export type ListSeatHandoffsQuery = {
  scopeRef?: string | undefined
  project?: string | undefined
  /** Acknowledged ones too; HRC lists only pending ones otherwise. */
  all?: boolean | undefined
}

export class AcpHrcSdkClient extends HrcClient {
  /** `GET /v1/seat-handoffs` (T-12715): what `prae seat handoff find` reads. */
  listSeatHandoffs(query: ListSeatHandoffsQuery): Promise<{ handoffs: HrcSeatHandoff[] }> {
    const params = new URLSearchParams()
    if (query.scopeRef !== undefined) params.set('scopeRef', query.scopeRef)
    if (query.project !== undefined) params.set('project', query.project)
    if (query.all === true) params.set('all', 'true')
    return this.getJson(`/v1/seat-handoffs?${params}`)
  }
}
