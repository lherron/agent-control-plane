import type { SessionRef } from 'agent-scope'

import type { CoordinationStore } from '../storage/open-store.js'
import { type WakeRequestRow, hydrateWakeRequest } from '../storage/records.js'
import type { WakeRequest } from '../types/wake-request.js'
import { formatCanonicalSessionRef } from '../util/session-ref.js'

export type PendingWakeQuery = {
  projectId: string
  sessionRef?: SessionRef | undefined
}

export function listPendingWakes(store: CoordinationStore, query: PendingWakeQuery): WakeRequest[] {
  if (query.sessionRef !== undefined) {
    const rows = store.sqlite
      .query<WakeRequestRow, [string, string]>(
        `
          SELECT *
          FROM wake_requests
          WHERE project_id = ?
            AND session_ref = ?
            AND state IN ('queued', 'leased')
          ORDER BY created_at ASC, wake_id ASC
        `
      )
      .all(query.projectId, formatCanonicalSessionRef(query.sessionRef))

    return rows.map((row) => hydrateWakeRequest(row))
  }

  const rows = store.sqlite
    .query<WakeRequestRow, [string]>(
      `
        SELECT *
        FROM wake_requests
        WHERE project_id = ?
          AND state IN ('queued', 'leased')
        ORDER BY created_at ASC, wake_id ASC
      `
    )
    .all(query.projectId)

  return rows.map((row) => hydrateWakeRequest(row))
}
