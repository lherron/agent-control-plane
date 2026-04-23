import { type SessionRef, normalizeSessionRef } from 'agent-scope'

import type { FailedDeliveryRecord, LastDeliveryRecord } from '../types.js'

import type { RepoContext } from './shared.js'
import { toOptionalString } from './shared.js'

type LastDeliveryContextRow = {
  gateway_id: string
  conversation_ref: string
  thread_ref: string | null
  delivery_request_id: string
  acked_at: string
}

function mapLastDeliveryContextRow(row: LastDeliveryContextRow): LastDeliveryRecord {
  return {
    gatewayId: row.gateway_id,
    conversationRef: row.conversation_ref,
    threadRef: toOptionalString(row.thread_ref),
    deliveryRequestId: row.delivery_request_id,
    ackedAt: row.acked_at,
  }
}

export class LastDeliveryContextRepo {
  constructor(private readonly context: RepoContext) {}

  record(sessionRef: SessionRef, record: LastDeliveryRecord): void {
    this.recordAckedDelivery(sessionRef, record)
  }

  recordAckedDelivery(sessionRef: SessionRef, record: LastDeliveryRecord): void {
    const canonicalSessionRef = normalizeSessionRef(sessionRef)

    this.context.sqlite
      .prepare(
        `INSERT INTO last_delivery_context (
           scope_ref,
           lane_ref,
           gateway_id,
           conversation_ref,
           thread_ref,
           delivery_request_id,
           acked_at,
           updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (scope_ref, lane_ref) DO UPDATE SET
           gateway_id = excluded.gateway_id,
           conversation_ref = excluded.conversation_ref,
           thread_ref = excluded.thread_ref,
           delivery_request_id = excluded.delivery_request_id,
           acked_at = excluded.acked_at,
           updated_at = excluded.updated_at
         WHERE excluded.acked_at > last_delivery_context.acked_at`
      )
      .run(
        canonicalSessionRef.scopeRef,
        canonicalSessionRef.laneRef,
        record.gatewayId,
        record.conversationRef,
        record.threadRef ?? null,
        record.deliveryRequestId,
        record.ackedAt,
        record.ackedAt
      )
  }

  recordFailedDelivery(sessionRef: SessionRef, record: FailedDeliveryRecord): void {
    void sessionRef
    void record
  }

  get(sessionRef: SessionRef): LastDeliveryRecord | undefined {
    return this.getLastDelivery(sessionRef)
  }

  getLastDelivery(sessionRef: SessionRef): LastDeliveryRecord | undefined {
    const canonicalSessionRef = normalizeSessionRef(sessionRef)

    const row = this.context.sqlite
      .prepare(
        `SELECT gateway_id,
                conversation_ref,
                thread_ref,
                delivery_request_id,
                acked_at
           FROM last_delivery_context
          WHERE scope_ref = ?
            AND lane_ref = ?`
      )
      .get(canonicalSessionRef.scopeRef, canonicalSessionRef.laneRef) as
      | LastDeliveryContextRow
      | undefined

    return row === undefined ? undefined : mapLastDeliveryContextRow(row)
  }
}
