import type { Actor, AttachmentRef } from 'acp-core'

import { randomUUID } from 'node:crypto'

import type {
  DeliveryFailureInput,
  DeliveryRequest,
  EnqueueDeliveryRequestIdempotencyInput,
  EnqueueDeliveryRequestIdempotencyResult,
  EnqueueDeliveryRequestInput,
  ListFailedDeliveryRequestsInput,
  RequeueDeliveryRequestResult,
} from '../types.js'

import type { RepoContext } from './shared.js'
import { toOptionalString } from './shared.js'

const DEFAULT_FAILED_LIMIT = 50
const REQUEUED_ID_SLICE_LENGTH = 12

const DELIVERY_REQUEST_COLUMNS = `delivery_request_id,
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
                outcome_state,
                outcome_reason,
                outcome_source,
                outcome_details_json,
                status,
                created_at,
                delivered_at,
                failure_code,
                failure_message`

const DELIVERY_REQUEST_INSERT_COLUMNS = `delivery_request_id,
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
           outcome_state,
           outcome_reason,
           outcome_source,
           outcome_details_json,
           status,
           created_at,
           delivered_at,
           failure_code,
           failure_message`

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
  outcome_state: string | null
  outcome_reason: string | null
  outcome_source: string | null
  outcome_details_json: string | null
  status: DeliveryRequest['status']
  created_at: string
  delivered_at: string | null
  failure_code: string | null
  failure_message: string | null
}

type MappedDeliveryOutcome = NonNullable<DeliveryRequest['outcome']>
type DegradedDeliveryOutcome = Extract<MappedDeliveryOutcome, { state: 'degraded' }>
type DegradedDeliveryOutcomeReason = DegradedDeliveryOutcome['reason']
type DegradedDeliveryOutcomeBuilder = (row: DeliveryRequestRow) => DegradedDeliveryOutcome

const DEGRADED_DELIVERY_OUTCOME_BUILDERS: Record<
  DegradedDeliveryOutcomeReason,
  DegradedDeliveryOutcomeBuilder
> = {
  launch_signalled: (row) => {
    const details = parseOutcomeDetails(row.outcome_details_json)
    return {
      state: 'degraded',
      reason: 'launch_signalled',
      ...mapOutcomeSource(row),
      signal: (details?.['signal'] as string) ?? 'UNKNOWN',
    }
  },
  launch_failed: (row) => {
    const details = parseOutcomeDetails(row.outcome_details_json)
    return {
      state: 'degraded',
      reason: 'launch_failed',
      ...mapOutcomeSource(row),
      exitCode: (details?.['exitCode'] as number) ?? 1,
    }
  },
  no_assistant_content: (row) => {
    const details = parseOutcomeDetails(row.outcome_details_json)
    const errorMessage =
      typeof details?.['errorMessage'] === 'string' ? details['errorMessage'] : undefined
    return {
      state: 'degraded',
      reason: 'no_assistant_content',
      ...mapOutcomeSource(row),
      ...(errorMessage !== undefined ? { details: { errorMessage } } : {}),
    }
  },
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
    ...mapDeliveryOutcome(row),
    status: row.status,
    createdAt: row.created_at,
    deliveredAt: toOptionalString(row.delivered_at),
    failureCode: toOptionalString(row.failure_code),
    failureMessage: toOptionalString(row.failure_message),
  }
}

function mapDeliveryOutcome(row: DeliveryRequestRow): Pick<DeliveryRequest, 'outcome'> {
  if (row.outcome_state === 'degraded' && isDegradedDeliveryOutcomeReason(row.outcome_reason)) {
    return { outcome: DEGRADED_DELIVERY_OUTCOME_BUILDERS[row.outcome_reason](row) }
  }

  if (row.outcome_state === 'normal') {
    return { outcome: { state: 'normal' } }
  }

  return {}
}

function isDegradedDeliveryOutcomeReason(
  reason: string | null
): reason is DegradedDeliveryOutcomeReason {
  return (
    reason === 'launch_signalled' || reason === 'launch_failed' || reason === 'no_assistant_content'
  )
}

function mapOutcomeSource(row: DeliveryRequestRow): Pick<DegradedDeliveryOutcome, 'source'> {
  const source = toOptionalString(row.outcome_source)
  return source !== undefined ? { source } : {}
}

function parseOutcomeDetails(json: string | null): Record<string, unknown> | undefined {
  if (json === null || json.trim().length === 0) {
    return undefined
  }
  try {
    return JSON.parse(json) as Record<string, unknown>
  } catch {
    return undefined
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

function serializeOutcomeDetails(outcome: EnqueueDeliveryRequestInput['outcome']): string | null {
  if (outcome === undefined || outcome.state !== 'degraded') {
    return null
  }

  const details: Record<string, unknown> = {}
  if ('signal' in outcome && outcome.signal !== undefined) {
    details['signal'] = outcome.signal
  }
  if ('exitCode' in outcome && outcome.exitCode !== undefined) {
    details['exitCode'] = outcome.exitCode
  }
  if (outcome.reason === 'no_assistant_content' && outcome.details?.errorMessage !== undefined) {
    details['errorMessage'] = outcome.details.errorMessage
  }

  return Object.keys(details).length > 0 ? JSON.stringify(details) : null
}

type DeliveryRowInsert = {
  deliveryRequestId: string
  linkedFailureId: string | null
  actor: Actor
  gatewayId: string
  bindingId: string
  scopeRef: string
  laneRef: string
  runId?: string | undefined
  inputAttemptId?: string | undefined
  conversationRef: string
  threadRef?: string | undefined
  replyToMessageRef?: string | undefined
  bodyKind: EnqueueDeliveryRequestInput['bodyKind']
  bodyText: string
  bodyAttachments?: AttachmentRef[] | undefined
  outcome?: EnqueueDeliveryRequestInput['outcome']
  createdAt: string
}

export class DeliveryRequestRepo {
  constructor(private readonly context: RepoContext) {}

  private insertQueuedRow(row: DeliveryRowInsert): void {
    this.context.sqlite
      .prepare(
        `INSERT INTO delivery_requests (
           ${DELIVERY_REQUEST_INSERT_COLUMNS}
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'queued', ?, NULL, NULL, NULL)`
      )
      .run(
        row.deliveryRequestId,
        row.linkedFailureId,
        row.actor.kind,
        row.actor.id,
        row.actor.displayName ?? null,
        row.gatewayId,
        row.bindingId,
        row.scopeRef,
        row.laneRef,
        row.runId ?? null,
        row.inputAttemptId ?? null,
        row.conversationRef,
        row.threadRef ?? null,
        row.replyToMessageRef ?? null,
        row.bodyKind,
        row.bodyText,
        serializeBodyAttachments(row.bodyAttachments),
        row.outcome?.state ?? null,
        row.outcome?.state === 'degraded' ? row.outcome.reason : null,
        row.outcome?.state === 'degraded' ? (row.outcome.source ?? null) : null,
        serializeOutcomeDetails(row.outcome),
        row.createdAt
      )
  }

  enqueue(input: EnqueueDeliveryRequestInput): DeliveryRequest {
    const actor = input.actor ?? { kind: 'system', id: 'acp-local' }
    this.insertQueuedRow({
      deliveryRequestId: input.deliveryRequestId,
      linkedFailureId: null,
      actor,
      gatewayId: input.gatewayId,
      bindingId: input.bindingId,
      scopeRef: input.scopeRef,
      laneRef: input.laneRef,
      runId: input.runId,
      inputAttemptId: input.inputAttemptId,
      conversationRef: input.conversationRef,
      threadRef: input.threadRef,
      replyToMessageRef: input.replyToMessageRef,
      bodyKind: input.bodyKind,
      bodyText: input.bodyText,
      bodyAttachments: input.bodyAttachments,
      outcome: input.outcome,
      createdAt: input.createdAt,
    })

    return this.require(input.deliveryRequestId)
  }

  enqueueIdempotent(
    input: EnqueueDeliveryRequestIdempotencyInput
  ): EnqueueDeliveryRequestIdempotencyResult {
    return this.context.sqlite.transaction(() => {
      const existing = this.context.sqlite
        .prepare(
          `SELECT fingerprint_hash,
                  delivery_request_id
             FROM delivery_request_idempotency
            WHERE route = ?
              AND idempotency_key = ?`
        )
        .get(input.route, input.idempotencyKey) as
        | { fingerprint_hash: string; delivery_request_id: string }
        | undefined

      if (existing !== undefined) {
        if (existing.fingerprint_hash !== input.fingerprintHash) {
          return {
            ok: false,
            code: 'idempotency_conflict',
            existingDeliveryRequestId: existing.delivery_request_id,
          } satisfies EnqueueDeliveryRequestIdempotencyResult
        }

        const delivery = this.get(existing.delivery_request_id)
        if (delivery === undefined) {
          return {
            ok: false,
            code: 'delivery_not_found',
            existingDeliveryRequestId: existing.delivery_request_id,
          } satisfies EnqueueDeliveryRequestIdempotencyResult
        }

        return {
          ok: true,
          created: false,
          delivery,
        } satisfies EnqueueDeliveryRequestIdempotencyResult
      }

      const delivery = this.enqueue(input)
      this.context.sqlite
        .prepare(
          `INSERT INTO delivery_request_idempotency (
             route,
             idempotency_key,
             fingerprint_hash,
             delivery_request_id,
             created_at
           ) VALUES (?, ?, ?, ?, ?)`
        )
        .run(
          input.route,
          input.idempotencyKey,
          input.fingerprintHash,
          delivery.deliveryRequestId,
          input.createdAt
        )

      return { ok: true, created: true, delivery } satisfies EnqueueDeliveryRequestIdempotencyResult
    })()
  }

  listQueuedForGateway(gatewayId: string): DeliveryRequest[] {
    const rows = this.context.sqlite
      .prepare(
        `SELECT ${DELIVERY_REQUEST_COLUMNS}
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
        `SELECT ${DELIVERY_REQUEST_COLUMNS}
           FROM delivery_requests
          WHERE delivery_request_id = ?`
      )
      .get(deliveryRequestId) as DeliveryRequestRow | undefined

    return row === undefined ? undefined : mapDeliveryRequestRow(row)
  }

  listByRun(runId: string): DeliveryRequest[] {
    const rows = this.context.sqlite
      .prepare(
        `SELECT ${DELIVERY_REQUEST_COLUMNS}
           FROM delivery_requests
          WHERE run_id = ?
          ORDER BY created_at ASC, delivery_request_id ASC`
      )
      .all(runId) as DeliveryRequestRow[]

    return rows.map(mapDeliveryRequestRow)
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

    const limit = input.limit ?? DEFAULT_FAILED_LIMIT

    const rows = this.context.sqlite
      .prepare(
        `SELECT ${DELIVERY_REQUEST_COLUMNS}
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

      const requeuedDeliveryRequestId = `dr_${randomUUID()
        .replace(/-/g, '')
        .slice(0, REQUEUED_ID_SLICE_LENGTH)}`
      const createdAt = new Date().toISOString()

      this.insertQueuedRow({
        deliveryRequestId: requeuedDeliveryRequestId,
        linkedFailureId: source.deliveryRequestId,
        actor: source.actor,
        gatewayId: source.gatewayId,
        bindingId: source.bindingId,
        scopeRef: source.scopeRef,
        laneRef: source.laneRef,
        runId: source.runId,
        inputAttemptId: source.inputAttemptId,
        conversationRef: source.conversationRef,
        threadRef: source.threadRef,
        replyToMessageRef: source.replyToMessageRef,
        bodyKind: source.bodyKind,
        bodyText: source.bodyText,
        bodyAttachments: source.bodyAttachments,
        outcome: source.outcome,
        createdAt,
      })

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
