import type { Actor, AttachmentRef } from 'acp-core'

import { randomUUID } from 'node:crypto'

import type {
  DeliveryFailureInput,
  DeliveryRequest,
  EnqueueDeliveryRequestInput,
  ListFailedDeliveryRequestsInput,
  RequeueDeliveryRequestResult,
} from '../types.js'

import type { RepoContext } from './shared.js'
import { toOptionalString } from './shared.js'

type DeliveryRequestRow = {
  delivery_request_id: string
  linked_failure_id: string | null
  actor_kind: Actor['kind'] | null
  actor_id: string | null
  actor_display_name: string | null
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
  body_attachments_json: string | null
  status: DeliveryRequest['status']
  created_at: string
  delivered_at: string | null
  failure_code: string | null
  failure_message: string | null
}

function mapDeliveryRequestRow(row: DeliveryRequestRow): DeliveryRequest {
  const bodyAttachments = parseBodyAttachments(row.body_attachments_json, row.delivery_request_id)

  return {
    deliveryRequestId: row.delivery_request_id,
    linkedFailureId: toOptionalString(row.linked_failure_id),
    actor: {
      kind: (row.actor_kind ?? 'system') as Actor['kind'],
      id: row.actor_id ?? 'acp-local',
      ...(toOptionalString(row.actor_display_name) !== undefined
        ? { displayName: toOptionalString(row.actor_display_name) }
        : {}),
    },
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
    ...(bodyAttachments !== undefined ? { bodyAttachments } : {}),
    status: row.status,
    createdAt: row.created_at,
    deliveredAt: toOptionalString(row.delivered_at),
    failureCode: toOptionalString(row.failure_code),
    failureMessage: toOptionalString(row.failure_message),
  }
}

function parseBodyAttachments(
  value: string | null,
  deliveryRequestId: string
): AttachmentRef[] | undefined {
  if (value === null || value.trim().length === 0) {
    return undefined
  }

  const parsed = JSON.parse(value) as unknown
  if (!Array.isArray(parsed)) {
    throw new Error(`delivery request ${deliveryRequestId} has malformed body attachments`)
  }

  return parsed as AttachmentRef[]
}

function serializeBodyAttachments(attachments: AttachmentRef[] | undefined): string | null {
  if (attachments === undefined || attachments.length === 0) {
    return null
  }

  return JSON.stringify(attachments)
}

export class DeliveryRequestRepo {
  constructor(private readonly context: RepoContext) {}

  enqueue(input: EnqueueDeliveryRequestInput): DeliveryRequest {
    const actor = input.actor ?? { kind: 'system', id: 'acp-local' }
    this.context.sqlite
      .prepare(
        `INSERT INTO delivery_requests (
           delivery_request_id,
           linked_failure_id,
           actor_kind,
           actor_id,
           actor_display_name,
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
           body_attachments_json,
           status,
           created_at,
           delivered_at,
           failure_code,
           failure_message
         ) VALUES (?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'queued', ?, NULL, NULL, NULL)`
      )
      .run(
        input.deliveryRequestId,
        actor.kind,
        actor.id,
        actor.displayName ?? null,
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
        serializeBodyAttachments(input.bodyAttachments),
        input.createdAt
      )

    return this.require(input.deliveryRequestId)
  }

  listQueuedForGateway(gatewayId: string): DeliveryRequest[] {
    const rows = this.context.sqlite
      .prepare(
        `SELECT delivery_request_id,
                linked_failure_id,
                actor_kind,
                actor_id,
                actor_display_name,
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
                body_attachments_json,
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

      this.context.sqlite
        .prepare(
          `UPDATE outbound_attachments
              SET state = 'delivered',
                  updatedAt = ?
            WHERE consumedByDeliveryRequestId = ?
              AND state = 'consumed'`
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
                linked_failure_id,
                actor_kind,
                actor_id,
                actor_display_name,
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
                body_attachments_json,
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

  listFailed(input: ListFailedDeliveryRequestsInput = {}): DeliveryRequest[] {
    const where = [`status = 'failed'`]
    const params: unknown[] = []

    if (input.gatewayId !== undefined) {
      where.push('gateway_id = ?')
      params.push(input.gatewayId)
    }

    if (input.since !== undefined) {
      where.push('created_at > ?')
      params.push(input.since)
    }

    const limit = input.limit ?? 50

    const rows = this.context.sqlite
      .prepare(
        `SELECT delivery_request_id,
                linked_failure_id,
                actor_kind,
                actor_id,
                actor_display_name,
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
                body_attachments_json,
                status,
                created_at,
                delivered_at,
                failure_code,
                failure_message
           FROM delivery_requests
          WHERE ${where.join(' AND ')}
          ORDER BY created_at ASC, delivery_request_id ASC
          LIMIT ?`
      )
      .all(...params, limit) as DeliveryRequestRow[]

    return rows.map(mapDeliveryRequestRow)
  }

  requeue(deliveryRequestId: string, input: { requeuedBy: string }): RequeueDeliveryRequestResult {
    void input.requeuedBy

    return this.context.sqlite.transaction(() => {
      const source = this.get(deliveryRequestId)
      if (source === undefined) {
        return { ok: false, code: 'not_found' } satisfies RequeueDeliveryRequestResult
      }

      if (source.status !== 'failed') {
        return { ok: false, code: 'wrong_state' } satisfies RequeueDeliveryRequestResult
      }

      const requeuedDeliveryRequestId = `dr_${randomUUID().replace(/-/g, '').slice(0, 12)}`
      const createdAt = new Date().toISOString()

      this.context.sqlite
        .prepare(
          `INSERT INTO delivery_requests (
             delivery_request_id,
             linked_failure_id,
             actor_kind,
             actor_id,
             actor_display_name,
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
             body_attachments_json,
             status,
             created_at,
             delivered_at,
             failure_code,
             failure_message
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'queued', ?, NULL, NULL, NULL)`
        )
        .run(
          requeuedDeliveryRequestId,
          source.deliveryRequestId,
          source.actor.kind,
          source.actor.id,
          source.actor.displayName ?? null,
          source.gatewayId,
          source.bindingId,
          source.scopeRef,
          source.laneRef,
          source.runId ?? null,
          source.inputAttemptId ?? null,
          source.conversationRef,
          source.threadRef ?? null,
          source.replyToMessageRef ?? null,
          source.bodyKind,
          source.bodyText,
          serializeBodyAttachments(source.bodyAttachments),
          createdAt
        )

      return {
        ok: true,
        delivery: this.require(requeuedDeliveryRequestId) as DeliveryRequest & {
          linkedFailureId: string
          status: 'queued'
        },
      } satisfies RequeueDeliveryRequestResult
    })()
  }

  private require(deliveryRequestId: string): DeliveryRequest {
    const deliveryRequest = this.get(deliveryRequestId)
    if (deliveryRequest === undefined) {
      throw new Error(`Failed to reload delivery request ${deliveryRequestId}`)
    }

    return deliveryRequest
  }
}
