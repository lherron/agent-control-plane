import type {
  DeliveryFailureInput,
  DeliveryRequest,
  EnqueueDeliveryRequestInput,
} from '../types.js'

import type { RepoContext } from './shared.js'
import { toOptionalString } from './shared.js'

type DeliveryRequestRow = {
  delivery_request_id: string
  gateway_id: string
  binding_id: string
  scope_ref: string
  lane_ref: string
  run_id: string | null
  input_attempt_id: string | null
  conversation_ref: string
  thread_ref: string | null
  reply_to_message_ref: string | null
  body_kind: DeliveryRequest['bodyKind']
  body_text: string
  status: DeliveryRequest['status']
  created_at: string
  delivered_at: string | null
  failure_code: string | null
  failure_message: string | null
}

function mapDeliveryRequestRow(row: DeliveryRequestRow): DeliveryRequest {
  return {
    deliveryRequestId: row.delivery_request_id,
    gatewayId: row.gateway_id,
    bindingId: row.binding_id,
    scopeRef: row.scope_ref,
    laneRef: row.lane_ref,
    runId: toOptionalString(row.run_id),
    inputAttemptId: toOptionalString(row.input_attempt_id),
    conversationRef: row.conversation_ref,
    threadRef: toOptionalString(row.thread_ref),
    replyToMessageRef: toOptionalString(row.reply_to_message_ref),
    bodyKind: row.body_kind,
    bodyText: row.body_text,
    status: row.status,
    createdAt: row.created_at,
    deliveredAt: toOptionalString(row.delivered_at),
    failureCode: toOptionalString(row.failure_code),
    failureMessage: toOptionalString(row.failure_message),
  }
}

export class DeliveryRequestRepo {
  constructor(private readonly context: RepoContext) {}

  enqueue(input: EnqueueDeliveryRequestInput): DeliveryRequest {
    this.context.sqlite
      .prepare(
        `INSERT INTO delivery_requests (
           delivery_request_id,
           gateway_id,
           binding_id,
           scope_ref,
           lane_ref,
           run_id,
           input_attempt_id,
           conversation_ref,
           thread_ref,
           reply_to_message_ref,
           body_kind,
           body_text,
           status,
           created_at,
           delivered_at,
           failure_code,
           failure_message
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'queued', ?, NULL, NULL, NULL)`
      )
      .run(
        input.deliveryRequestId,
        input.gatewayId,
        input.bindingId,
        input.scopeRef,
        input.laneRef,
        input.runId ?? null,
        input.inputAttemptId ?? null,
        input.conversationRef,
        input.threadRef ?? null,
        input.replyToMessageRef ?? null,
        input.bodyKind,
        input.bodyText,
        input.createdAt
      )

    return this.require(input.deliveryRequestId)
  }

  listQueuedForGateway(gatewayId: string): DeliveryRequest[] {
    const rows = this.context.sqlite
      .prepare(
        `SELECT delivery_request_id,
                gateway_id,
                binding_id,
                scope_ref,
                lane_ref,
                run_id,
                input_attempt_id,
                conversation_ref,
                thread_ref,
                reply_to_message_ref,
                body_kind,
                body_text,
                status,
                created_at,
                delivered_at,
                failure_code,
                failure_message
          FROM delivery_requests
          WHERE gateway_id = ?
            AND status = 'queued'
          ORDER BY created_at ASC, COALESCE(run_id, '') ASC, delivery_request_id ASC`
      )
      .all(gatewayId) as DeliveryRequestRow[]

    return rows.map(mapDeliveryRequestRow)
  }

  leaseNext(gatewayId: string): DeliveryRequest | undefined {
    return this.context.sqlite.transaction(() => {
      const next = this.context.sqlite
        .prepare(
          `SELECT delivery_request_id
            FROM delivery_requests
           WHERE gateway_id = ?
             AND status = 'queued'
            ORDER BY created_at ASC, COALESCE(run_id, '') ASC, delivery_request_id ASC
            LIMIT 1`
        )
        .get(gatewayId) as { delivery_request_id: string } | undefined

      if (next === undefined) {
        return undefined
      }

      const result = this.context.sqlite
        .prepare(
          `UPDATE delivery_requests
              SET status = 'delivering'
            WHERE delivery_request_id = ?
              AND status = 'queued'`
        )
        .run(next.delivery_request_id)

      if (result.changes === 0) {
        return undefined
      }

      return this.require(next.delivery_request_id)
    })()
  }

  ack(deliveryRequestId: string, deliveredAt: string): DeliveryRequest | undefined {
    return this.context.sqlite.transaction(() => {
      this.context.sqlite
        .prepare(
          `UPDATE delivery_requests
              SET status = 'delivered',
                  delivered_at = ?,
                  failure_code = NULL,
                  failure_message = NULL
            WHERE delivery_request_id = ?
              AND status IN ('queued', 'delivering')`
        )
        .run(deliveredAt, deliveryRequestId)

      return this.get(deliveryRequestId)
    })()
  }

  fail(input: DeliveryFailureInput): DeliveryRequest | undefined {
    return this.context.sqlite.transaction(() => {
      this.context.sqlite
        .prepare(
          `UPDATE delivery_requests
              SET status = 'failed',
                  delivered_at = NULL,
                  failure_code = ?,
                  failure_message = ?
            WHERE delivery_request_id = ?
              AND status IN ('queued', 'delivering')`
        )
        .run(input.failureCode, input.failureMessage, input.deliveryRequestId)

      return this.get(input.deliveryRequestId)
    })()
  }

  get(deliveryRequestId: string): DeliveryRequest | undefined {
    const row = this.context.sqlite
      .prepare(
        `SELECT delivery_request_id,
                gateway_id,
                binding_id,
                scope_ref,
                lane_ref,
                run_id,
                input_attempt_id,
                conversation_ref,
                thread_ref,
                reply_to_message_ref,
                body_kind,
                body_text,
                status,
                created_at,
                delivered_at,
                failure_code,
                failure_message
           FROM delivery_requests
          WHERE delivery_request_id = ?`
      )
      .get(deliveryRequestId) as DeliveryRequestRow | undefined

    return row === undefined ? undefined : mapDeliveryRequestRow(row)
  }

  private require(deliveryRequestId: string): DeliveryRequest {
    const deliveryRequest = this.get(deliveryRequestId)
    if (deliveryRequest === undefined) {
      throw new Error(`Failed to reload delivery request ${deliveryRequestId}`)
    }

    return deliveryRequest
  }
}
